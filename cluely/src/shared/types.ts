// NOTE: keep this file TYPE-ONLY.
// It is compiled by both tsconfig.main.json (CommonJS) and tsconfig.renderer.json
// (ESM) into the same dist/shared/types.js. Type-only exports are erased at every
// import site, so nothing ever requires the emitted file at runtime. Adding a
// runtime export here would break the main process.

/** Who produced a piece of audio. `me` = microphone, `them` = system/loopback audio. */
export type Speaker = 'me' | 'them';

export type ListenState = 'idle' | 'starting' | 'listening' | 'error';

export type SttState = 'down' | 'connecting' | 'up';

export interface SourceStatus {
  capturing: boolean;
  stt: SttState;
  error?: string;
}

export interface Status {
  state: ListenState;
  mic: SourceStatus;
  system: SourceStatus;
  autoAnswer: boolean;
  clickThrough: boolean;
  /** Human-readable summary of the indexed materials library. */
  materials?: string;
  message?: string;
}

export interface TranscriptLine {
  id: string;
  speaker: Speaker;
  text: string;
  /** false while the line is still being revised by the STT engine. */
  final: boolean;
  at: number;
}

export type AnswerStatus = 'thinking' | 'streaming' | 'done' | 'error';

export interface AnswerCard {
  id: string;
  question: string;
  body: string;
  status: AnswerStatus;
  trigger: 'auto' | 'manual';
  at: number;
}

/** Partial update pushed to the overlay as an answer streams in. */
export interface AnswerPatch {
  id: string;
  question?: string;
  /** Text to append to the card body. */
  append?: string;
  /** Replace the whole body (used for errors). */
  body?: string;
  status?: AnswerStatus;
  trigger?: 'auto' | 'manual';
  at?: number;
}

export interface CaptureState {
  source: Speaker;
  capturing: boolean;
  error?: string;
}
