import type { Config } from '../config';
import { ClaudeProvider } from './claude';
import { OllamaProvider } from './ollama';
import type { AnswerProvider } from './types';

export function createAnswerProvider(cfg: Config): AnswerProvider {
  switch (cfg.answerProvider) {
    case 'ollama':
      return new OllamaProvider(cfg);
    case 'claude':
      return new ClaudeProvider(cfg);
  }
}

export type { AnswerProvider, GenerateRequest } from './types';
