import type { Config } from '../config';
import { DeepgramProvider } from './deepgram';
import type { SttProvider } from './types';

/**
 * Swap in another engine here (Whisper, AssemblyAI, a local model) by
 * implementing SttProvider — nothing upstream knows which one is in use.
 */
export function createSttProvider(cfg: Config): SttProvider {
  const requested = (process.env.STT_PROVIDER ?? 'deepgram').trim().toLowerCase();
  switch (requested) {
    case 'deepgram':
      return new DeepgramProvider(cfg);
    default:
      throw new Error(`Unknown STT_PROVIDER "${requested}" (supported: deepgram)`);
  }
}

export type { SttProvider, SttSession, SttEvents } from './types';
export { SAMPLE_RATE } from './types';
