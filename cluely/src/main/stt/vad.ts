/**
 * Energy-gated utterance segmenter.
 *
 * Deepgram did endpointing server-side. Running Whisper locally means we have to
 * decide for ourselves where an utterance starts and stops, because Whisper
 * transcribes a finite clip — it has no notion of a stream.
 *
 * The gate adapts to the room: the noise floor tracks the quiet passages, so a
 * loud fan or a hissy headset mic doesn't read as perpetual speech.
 */

export interface SegmenterOptions {
  sampleRate: number;
  /** Silence needed to call an utterance finished. */
  hangoverMs: number;
  /** Utterances shorter than this are noise, not speech. */
  minSpeechMs: number;
  /** Force a cut here so one long monologue still produces answers. */
  maxSegmentMs: number;
  /** Audio kept from before the trigger, so the first word isn't clipped. */
  preRollMs: number;
}

export const DEFAULT_SEGMENTER: Omit<SegmenterOptions, 'sampleRate'> = {
  hangoverMs: 700,
  minSpeechMs: 350,
  maxSegmentMs: 20_000,
  preRollMs: 300,
};

/** 20 ms analysis window. */
const FRAME_MS = 20;

function rms(samples: Int16Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i += 1) {
    const v = samples[i] / 32768;
    sum += v * v;
  }
  const n = Math.max(1, to - from);
  return Math.sqrt(sum / n);
}

export class UtteranceSegmenter {
  private readonly frameSamples: number;
  private readonly hangoverFrames: number;
  private readonly minSpeechFrames: number;
  private readonly maxSegmentSamples: number;
  private readonly preRollSamples: number;

  /** Samples not yet aligned to a frame boundary. */
  private carry = new Int16Array(0);
  /** Audio of the utterance being collected, plus its pre-roll. */
  private collected: Int16Array[] = [];
  private collectedLength = 0;
  /** Ring of recent frames kept while idle, to prepend when speech starts. */
  private preRoll: Int16Array[] = [];
  private preRollLength = 0;

  private speaking = false;
  private speechFrames = 0;
  private silenceFrames = 0;
  /** Tracks the quiet floor of the room; starts pessimistic and adapts down. */
  private noiseFloor = 0.005;

  constructor(
    private readonly options: SegmenterOptions,
    private readonly onUtterance: (pcm: Int16Array) => void,
  ) {
    this.frameSamples = Math.round((options.sampleRate * FRAME_MS) / 1000);
    this.hangoverFrames = Math.max(1, Math.round(options.hangoverMs / FRAME_MS));
    this.minSpeechFrames = Math.max(1, Math.round(options.minSpeechMs / FRAME_MS));
    this.maxSegmentSamples = Math.round((options.sampleRate * options.maxSegmentMs) / 1000);
    this.preRollSamples = Math.round((options.sampleRate * options.preRollMs) / 1000);
  }

  push(chunk: Int16Array): void {
    const merged = new Int16Array(this.carry.length + chunk.length);
    merged.set(this.carry, 0);
    merged.set(chunk, this.carry.length);

    let offset = 0;
    while (offset + this.frameSamples <= merged.length) {
      this.frame(merged.subarray(offset, offset + this.frameSamples));
      offset += this.frameSamples;
    }
    this.carry = merged.slice(offset);
  }

  private frame(frame: Int16Array): void {
    const level = rms(frame, 0, frame.length);
    // Speech has to clear the floor by a healthy margin, with an absolute floor
    // so a silent room can't drive the threshold to zero.
    const threshold = Math.max(this.noiseFloor * 3, 0.012);
    const isSpeech = level > threshold;

    if (!isSpeech) {
      // Adapt only on quiet frames, so loud speech never raises the floor.
      this.noiseFloor = this.noiseFloor * 0.95 + level * 0.05;
    }

    if (this.speaking) {
      this.collect(frame);
      if (isSpeech) {
        this.speechFrames += 1;
        this.silenceFrames = 0;
      } else {
        this.silenceFrames += 1;
        if (this.silenceFrames >= this.hangoverFrames) this.flush();
      }
      if (this.collectedLength >= this.maxSegmentSamples) this.flush();
      return;
    }

    if (isSpeech) {
      this.speaking = true;
      this.speechFrames = 1;
      this.silenceFrames = 0;
      // Start from the pre-roll so the utterance keeps its first consonant.
      this.collected = this.preRoll;
      this.collectedLength = this.preRollLength;
      this.preRoll = [];
      this.preRollLength = 0;
      this.collect(frame);
      return;
    }

    this.preRoll.push(frame);
    this.preRollLength += frame.length;
    while (this.preRollLength > this.preRollSamples && this.preRoll.length > 1) {
      const dropped = this.preRoll.shift();
      this.preRollLength -= dropped ? dropped.length : 0;
    }
  }

  private collect(frame: Int16Array): void {
    this.collected.push(frame);
    this.collectedLength += frame.length;
  }

  /** Emit the collected utterance, if it was long enough to be one. */
  flush(): void {
    const frames = this.collected;
    const length = this.collectedLength;
    const speechFrames = this.speechFrames;

    this.collected = [];
    this.collectedLength = 0;
    this.speaking = false;
    this.speechFrames = 0;
    this.silenceFrames = 0;

    if (!frames.length || speechFrames < this.minSpeechFrames) return;

    const pcm = new Int16Array(length);
    let offset = 0;
    for (const frame of frames) {
      pcm.set(frame, offset);
      offset += frame.length;
    }
    this.onUtterance(pcm);
  }

  reset(): void {
    this.carry = new Int16Array(0);
    this.collected = [];
    this.collectedLength = 0;
    this.preRoll = [];
    this.preRollLength = 0;
    this.speaking = false;
    this.speechFrames = 0;
    this.silenceFrames = 0;
  }
}

/** Minimal 16-bit mono WAV wrapper — whisper.cpp reads files, not streams. */
export function encodeWav(pcm: Int16Array, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const dataBytes = pcm.length * 2;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format: PCM
  header.writeUInt16LE(1, 22); // channels
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);

  return Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, dataBytes)]);
}
