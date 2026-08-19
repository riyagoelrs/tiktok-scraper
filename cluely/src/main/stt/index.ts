import type { Config } from '../config';
import { DeepgramProvider } from './deepgram';
import { WhisperProvider } from './whisper';
import type { SttProvider } from './types';

/**
 * Swap in another engine here (Whisper, AssemblyAI, a local model) by
 * implementing SttProvider — nothing upstream knows which one is in use.
 */
export function createSttProvider(cfg: Config): SttProvider {
  switch (cfg.sttProvider) {
    case 'whisper':
      return new WhisperProvider(cfg);
    case 'deepgram':
      return new DeepgramProvider(cfg);
  }
}

export type { SttProvider, SttSession, SttEvents } from './types';
export { SAMPLE_RATE } from './types';
