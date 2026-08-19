import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config';
import type { SttEvents, SttProvider, SttSession } from './types';
import { SAMPLE_RATE } from './types';
import { DEFAULT_SEGMENTER, UtteranceSegmenter, encodeWav } from './vad';

/**
 * Local transcription through whisper.cpp.
 *
 * It shells out to the whisper.cpp CLI rather than binding a native module.
 * Native addons have to be rebuilt against Electron's ABI on every Electron
 * bump, and a mismatch fails at runtime in the user's hands; a subprocess is
 * immune to all of that and costs a few milliseconds of spawn time per
 * utterance, which is noise next to inference.
 *
 * Whisper transcribes clips, not streams, so an utterance segmenter upstream
 * decides where speech starts and stops.
 */

/** whisper.cpp prints these when a segment is silence or noise. */
const NON_SPEECH = /^[\s]*[\[(](blank_audio|silence|music|inaudible|no speech|sound)[\])][\s]*$/i;

class WhisperSession implements SttSession {
  private readonly segmenter: UtteranceSegmenter;
  /** Utterances waiting to be transcribed; drained one at a time. */
  private queue: Int16Array[] = [];
  private working = false;
  private closed = false;

  constructor(
    readonly label: string,
    private readonly cfg: Config,
    private readonly events: SttEvents,
  ) {
    this.segmenter = new UtteranceSegmenter(
      { sampleRate: SAMPLE_RATE, ...DEFAULT_SEGMENTER },
      (pcm) => this.enqueue(pcm),
    );
    this.events.onState('up');
  }

  send(pcm: Buffer): void {
    if (this.closed) return;
    this.segmenter.push(
      new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)),
    );
  }

  private enqueue(pcm: Int16Array): void {
    this.queue.push(pcm);
    // Never let a backlog build: on a live call a transcript that is 30s behind
    // is worse than one with a gap in it.
    if (this.queue.length > 3) this.queue.splice(0, this.queue.length - 3);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.working || this.closed) return;
    this.working = true;
    try {
      while (this.queue.length && !this.closed) {
        const pcm = this.queue.shift();
        if (!pcm) break;
        const text = await this.transcribe(pcm);
        if (text) this.events.onFinal(text);
      }
    } finally {
      this.working = false;
    }
  }

  private transcribe(pcm: Int16Array): Promise<string> {
    const wav = path.join(os.tmpdir(), `cluely-${this.label}-${randomUUID()}.wav`);
    fs.writeFileSync(wav, encodeWav(pcm, SAMPLE_RATE));

    return new Promise((resolve) => {
      const args = [
        '-m', this.cfg.whisperModel,
        '-f', wav,
        '-t', String(this.cfg.whisperThreads),
        '-l', this.cfg.language,
        '--no-timestamps',
        '--no-prints',
      ];

      const child = spawn(this.cfg.whisperBinary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      child.on('error', (err: NodeJS.ErrnoException) => {
        fs.rmSync(wav, { force: true });
        this.events.onState(
          'down',
          err.code === 'ENOENT'
            ? `whisper binary not found at "${this.cfg.whisperBinary}" — set WHISPER_BINARY`
            : err.message,
        );
        resolve('');
      });

      child.on('close', (code) => {
        fs.rmSync(wav, { force: true });
        if (code !== 0) {
          this.events.onState('down', `whisper exited ${code}: ${stderr.trim().split('\n').pop() ?? ''}`);
          resolve('');
          return;
        }
        this.events.onState('up');
        resolve(clean(stdout));
      });
    });
  }

  close(): void {
    this.closed = true;
    this.segmenter.flush();
    this.segmenter.reset();
    this.queue = [];
  }
}

export function clean(raw: string): string {
  const text = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !NON_SPEECH.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  // A bare "you" or "thank you" is whisper's favourite hallucination on silence.
  if (/^(you|thank you|thanks for watching|bye)\.?$/i.test(text)) return '';
  return text;
}

export class WhisperProvider implements SttProvider {
  readonly name = 'whisper';

  constructor(private readonly cfg: Config) {}

  open(label: string, events: SttEvents): SttSession {
    if (!this.cfg.whisperModel) {
      throw new Error('WHISPER_MODEL is not set — point it at a ggml model file (see README)');
    }
    if (!fs.existsSync(this.cfg.whisperModel)) {
      throw new Error(`Whisper model not found at ${this.cfg.whisperModel}`);
    }
    return new WhisperSession(label, this.cfg, events);
  }
}
