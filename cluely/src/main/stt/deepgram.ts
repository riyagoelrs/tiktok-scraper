import WebSocket from 'ws';
import type { Config } from '../config';
import type { SttEvents, SttProvider, SttSession } from './types';
import { SAMPLE_RATE } from './types';

const KEEPALIVE_MS = 5_000;
const MAX_BACKOFF_MS = 8_000;
/** ~10s of audio. Enough to ride out a reconnect without growing without bound. */
const MAX_QUEUED_CHUNKS = 320;

interface DeepgramAlternative {
  transcript?: string;
}

interface DeepgramMessage {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: DeepgramAlternative[] };
}

/**
 * One duplex Deepgram streaming session, with reconnect. Deepgram emits a run of
 * `is_final` segments per utterance and then flags `speech_final` (or sends
 * `UtteranceEnd`); we stitch those segments together so downstream sees one
 * finalized utterance rather than a dribble of fragments.
 */
class DeepgramSession implements SttSession {
  private socket: WebSocket | undefined;
  private keepalive: NodeJS.Timeout | undefined;
  private reconnect: NodeJS.Timeout | undefined;
  private attempts = 0;
  private closed = false;
  /** Set when retrying can never help (bad key, revoked project). */
  private fatal: string | undefined;
  private queue: Buffer[] = [];
  /** Finalized segments of the utterance currently being spoken. */
  private segments: string[] = [];

  constructor(
    readonly label: string,
    private readonly url: string,
    private readonly apiKey: string,
    private readonly events: SttEvents,
  ) {
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    this.events.onState('connecting');

    const socket = new WebSocket(this.url, {
      headers: { Authorization: `Token ${this.apiKey}` },
    });
    this.socket = socket;

    socket.on('open', () => {
      this.attempts = 0;
      this.events.onState('up');
      for (const chunk of this.queue.splice(0)) socket.send(chunk);
      this.keepalive = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'KeepAlive' }));
        }
      }, KEEPALIVE_MS);
    });

    socket.on('unexpected-response', (_request, response) => {
      if (response.statusCode === 401 || response.statusCode === 403) {
        this.fatal = 'Deepgram rejected the API key — check DEEPGRAM_API_KEY';
      } else {
        this.fatal = `Deepgram refused the connection (HTTP ${response.statusCode})`;
      }
      socket.close();
    });

    socket.on('message', (raw) => this.handleMessage(raw.toString()));

    socket.on('error', (err: Error) => {
      // 'close' always follows, which is where the retry decision is made.
      this.events.onState('down', this.fatal ?? err.message);
    });

    socket.on('close', (code, reason) => {
      this.clearTimers();
      if (this.closed) return;
      if (this.fatal) {
        this.events.onState('down', this.fatal);
        return;
      }
      const detail = reason.toString() || `code ${code}`;
      this.events.onState('down', code === 1000 ? undefined : detail);
      this.scheduleReconnect();
    });
  }

  private handleMessage(raw: string): void {
    let msg: DeepgramMessage;
    try {
      msg = JSON.parse(raw) as DeepgramMessage;
    } catch {
      return;
    }

    if (msg.type === 'UtteranceEnd') {
      this.flush();
      return;
    }
    if (msg.type !== 'Results') return;

    const text = (msg.channel?.alternatives?.[0]?.transcript ?? '').trim();

    if (msg.is_final) {
      if (text) this.segments.push(text);
      // speech_final means Deepgram believes the speaker actually stopped.
      if (msg.speech_final) this.flush();
      else if (this.segments.length) this.events.onPartial(this.segments.join(' '));
      return;
    }

    if (text) this.events.onPartial([...this.segments, text].join(' '));
  }

  private flush(): void {
    const utterance = this.segments.join(' ').trim();
    this.segments = [];
    if (utterance) this.events.onFinal(utterance);
  }

  private scheduleReconnect(): void {
    const delay = Math.min(500 * 2 ** this.attempts, MAX_BACKOFF_MS);
    this.attempts += 1;
    this.reconnect = setTimeout(() => this.connect(), delay);
  }

  private clearTimers(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    if (this.reconnect) clearTimeout(this.reconnect);
    this.keepalive = undefined;
    this.reconnect = undefined;
  }

  send(pcm: Buffer): void {
    if (this.closed) return;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(pcm);
      return;
    }
    // Mid-reconnect: hold a bounded amount of audio so a blip doesn't lose a sentence.
    this.queue.push(pcm);
    if (this.queue.length > MAX_QUEUED_CHUNKS) this.queue.shift();
  }

  close(): void {
    this.closed = true;
    this.clearTimers();
    this.queue = [];
    this.flush();
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'CloseStream' }));
    }
    socket.close();
  }
}

export class DeepgramProvider implements SttProvider {
  readonly name = 'deepgram';
  private readonly url: string;

  constructor(private readonly cfg: Config) {
    const params = new URLSearchParams({
      model: cfg.deepgramModel,
      language: cfg.language,
      encoding: 'linear16',
      sample_rate: String(SAMPLE_RATE),
      channels: '1',
      interim_results: 'true',
      smart_format: 'true',
      punctuate: 'true',
      // Short endpointing keeps the copilot reacting mid-conversation rather than
      // waiting for a long pause.
      endpointing: '300',
      utterance_end_ms: '1000',
      vad_events: 'true',
    });
    this.url = `${cfg.deepgramEndpoint}?${params.toString()}`;
  }

  open(label: string, events: SttEvents): SttSession {
    if (!this.cfg.deepgramApiKey) {
      throw new Error('DEEPGRAM_API_KEY is not set — add it to .env');
    }
    return new DeepgramSession(label, this.url, this.cfg.deepgramApiKey, events);
  }
}
