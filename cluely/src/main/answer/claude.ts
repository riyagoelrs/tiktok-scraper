import Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../config';
import type { AnswerProvider, GenerateRequest } from './types';

/** Cloud fallback, kept behind the same interface as the local path. */
export class ClaudeProvider implements AnswerProvider {
  readonly name = 'claude';
  private client: Anthropic | undefined;

  constructor(private readonly cfg: Config) {}

  private getClient(): Anthropic {
    if (!this.client) {
      if (!this.cfg.anthropicApiKey) {
        throw new Error('ANTHROPIC_API_KEY is not set — add it to .env, or set ANSWER_PROVIDER=ollama');
      }
      this.client = new Anthropic({ apiKey: this.cfg.anthropicApiKey });
    }
    return this.client;
  }

  async generate(request: GenerateRequest): Promise<void> {
    try {
      const stream = this.getClient().messages.stream(
        {
          model: this.cfg.answerModel,
          max_tokens: request.maxTokens,
          system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: request.user }],
          output_config: { effort: this.cfg.answerEffort },
          thinking:
            this.cfg.answerThinking === 'adaptive' ? { type: 'adaptive' } : { type: 'disabled' },
        },
        { signal: request.signal },
      );

      stream.on('text', (delta) => request.onDelta(delta));
      const final = await stream.finalMessage();

      if (final.stop_reason === 'refusal') {
        throw new Error('Claude declined to answer this one. Ask it yourself, out loud.');
      }
    } catch (err) {
      if (request.signal.aborted) throw err;
      throw new Error(describeError(err));
    }
  }
}

/** Most specific first — a single catch-all would hide what is actually wrong. */
function describeError(err: unknown): string {
  if (err instanceof Anthropic.NotFoundError) return 'Model not found — check ANSWER_MODEL in .env.';
  if (err instanceof Anthropic.AuthenticationError) {
    return 'Anthropic rejected the API key — check ANTHROPIC_API_KEY.';
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return 'This API key is not allowed to use that model.';
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'Rate limited by the Anthropic API. Try again in a moment.';
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'Could not reach the Anthropic API — check your network.';
  }
  if (err instanceof Anthropic.APIError) {
    return `Anthropic API error ${err.status ?? '?'}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
