import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { readOperatorContext, type Config } from './config';
import type { Transcript } from './transcript';
import type { AnswerPatch } from '../shared/types';

const SYSTEM_PROMPT = `You are a live call copilot. You are fed a rolling transcript of a conversation: lines marked ME are the operator you work for, lines marked THEM are the other participants. The operator is on the call right now and cannot read for more than a couple of seconds.

Your job: answer the question THEM just asked, in a form the operator can say out loud immediately.

How to answer:
- Lead with the answer itself. No preamble, no restating the question, no "Great question".
- Default to 2-4 short bullets, under 60 words total. Only go longer when the answer is genuinely a list or a sequence of steps.
- Be concrete: names, numbers, the actual API, the actual tradeoff. Vague advice is useless at conversation speed.
- Use the operator context below whenever it is relevant. Never invent facts about the operator, their company, their history, or their numbers — if the context does not cover it, give the general answer and mark what only they can fill in with [your number here].
- If the question is ambiguous, give the most likely reading in one line, then offer the clarifying question the operator should ask back.
- Plain text only: short bullets with "-", no markdown headings, no bold, no code fences unless the answer is literally code.
- Do not include internal or system XML tags in your response.`;

export interface AnswerRequest {
  question: string;
  trigger: 'auto' | 'manual';
}

/**
 * Turns a question from the far side into a streamed answer card.
 * Only one answer runs at a time — a newer question cancels an older one, because
 * on a live call a stale answer is worse than no answer.
 */
export class AnswerEngine {
  private client: Anthropic | undefined;
  private inFlight: AbortController | undefined;

  constructor(
    private readonly cfg: Config,
    private readonly transcript: Transcript,
    private readonly emit: (patch: AnswerPatch) => void,
  ) {}

  private getClient(): Anthropic {
    if (!this.client) {
      if (!this.cfg.anthropicApiKey) {
        throw new Error('ANTHROPIC_API_KEY is not set — add it to cluely/.env');
      }
      this.client = new Anthropic({ apiKey: this.cfg.anthropicApiKey });
    }
    return this.client;
  }

  cancel(): void {
    this.inFlight?.abort();
    this.inFlight = undefined;
  }

  async answer(request: AnswerRequest): Promise<void> {
    this.cancel();

    const controller = new AbortController();
    this.inFlight = controller;

    const id = randomUUID();
    const question = request.question.trim() || '(what should I say next?)';
    this.emit({ id, question, body: '', status: 'thinking', trigger: request.trigger, at: Date.now() });

    try {
      const client = this.getClient();
      const stream = client.messages.stream(
        {
          model: this.cfg.answerModel,
          max_tokens: this.cfg.answerMaxTokens,
          system: [
            {
              type: 'text',
              text: this.buildSystem(),
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: [{ role: 'user', content: this.buildUserMessage(question) }],
          output_config: { effort: this.cfg.answerEffort },
          thinking:
            this.cfg.answerThinking === 'adaptive'
              ? { type: 'adaptive' }
              : { type: 'disabled' },
        },
        { signal: controller.signal },
      );

      let started = false;
      stream.on('text', (delta) => {
        if (!started) {
          started = true;
          this.emit({ id, status: 'streaming' });
        }
        this.emit({ id, append: delta });
      });

      const final = await stream.finalMessage();

      if (final.stop_reason === 'refusal') {
        this.emit({
          id,
          body: 'Claude declined to answer this one. Ask it yourself, out loud.',
          status: 'error',
        });
        return;
      }
      this.emit({ id, status: 'done' });
    } catch (err) {
      if (controller.signal.aborted) return; // superseded by a newer question
      this.emit({ id, body: describeError(err), status: 'error' });
    } finally {
      if (this.inFlight === controller) this.inFlight = undefined;
    }
  }

  private buildSystem(): string {
    // Re-read on every answer so edits to context.md take effect without a restart.
    const context = readOperatorContext(this.cfg);
    if (!context) return SYSTEM_PROMPT;
    return `${SYSTEM_PROMPT}\n\n<operator_context>\n${context}\n</operator_context>`;
  }

  private buildUserMessage(question: string): string {
    const window = this.transcript.render(this.cfg.contextLines);
    return [
      'Transcript so far:',
      window || '(nothing transcribed yet)',
      '',
      `They just asked: ${question}`,
      '',
      'Answer it for me now.',
    ].join('\n');
  }
}

/** Most specific first — a single catch-all would hide what is actually wrong. */
function describeError(err: unknown): string {
  if (err instanceof Anthropic.NotFoundError) {
    return 'Model not found — check ANSWER_MODEL in .env.';
  }
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
