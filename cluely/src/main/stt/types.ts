import type { SttState } from '../../shared/types';

export interface SttEvents {
  /** Fired continuously while someone is mid-sentence. Replaces the previous partial. */
  onPartial(text: string): void;
  /** Fired once per completed utterance. */
  onFinal(text: string): void;
  onState(state: SttState, error?: string): void;
}

export interface SttSession {
  readonly label: string;
  /** Feed one chunk of 16 kHz mono signed 16-bit little-endian PCM. */
  send(pcm: Buffer): void;
  close(): void;
}

export interface SttProvider {
  readonly name: string;
  open(label: string, events: SttEvents): SttSession;
}

/** All providers speak the same wire format, so capture only has to produce one. */
export const SAMPLE_RATE = 16_000;
