import { randomUUID } from 'node:crypto';
import { readOperatorContext, type Config } from './config';
import { createAnswerProvider, type AnswerProvider } from './answer';
import type { Materials } from './materials';
import type { Transcript } from './transcript';
import type { AnswerPatch } from '../shared/types';

const SYSTEM_PROMPT = `You are a live call copilot. You are fed a rolling transcript of a conversation: lines marked ME are the operator you work for, lines marked THEM are the other participants. The operator is on the call right now and cannot read for more than a couple of seconds.

Your job: answer the question THEM just asked, in a form the operator can say out loud immediately.

How to answer:
- Lead with the answer itself. No preamble, no restating the question, no "Great question".
- Default to 2-4 short bullets, under 60 words total. Only go longer when the answer is genuinely a list or a sequence of steps.
- Be concrete: names, numbers, the actual API, the actual tradeoff. Vague advice is useless at conversation speed.
- When the material below answers the question, use its wording and its numbers. That material is the operator's own preparation and it outranks your general knowledge.
- Never invent facts about the operator, their company, their history, or their numbers. If the material does not cover it, give the general answer and mark what only they can fill in with [your number here].
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
  private readonly provider: AnswerProvider;
  private inFlight: AbortController | undefined;

  constructor(
    private readonly cfg: Config,
    private readonly transcript: Transcript,
    private readonly materials: Materials,
    private readonly emit: (patch: AnswerPatch) => void,
  ) {
    this.provider = createAnswerProvider(cfg);
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
      const system = await this.buildSystem(question);
      if (controller.signal.aborted) return;

      let started = false;
      await this.provider.generate({
        system,
        user: this.buildUserMessage(question),
        maxTokens: this.cfg.answerMaxTokens,
        signal: controller.signal,
        onDelta: (delta) => {
          if (!started) {
            started = true;
            this.emit({ id, status: 'streaming' });
          }
          this.emit({ id, append: delta });
        },
      });

      this.emit({ id, status: started ? 'done' : 'error', ...(started ? {} : { body: 'The model returned nothing.' }) });
    } catch (err) {
      if (controller.signal.aborted) return; // superseded by a newer question
      this.emit({ id, body: err instanceof Error ? err.message : String(err), status: 'error' });
    } finally {
      if (this.inFlight === controller) this.inFlight = undefined;
    }
  }

  private async buildSystem(question: string): Promise<string> {
    // Both are re-read per answer so edits during a call take effect immediately.
    const context = readOperatorContext(this.cfg);
    const retrieved = await this.materials.prompt(question);

    let system = SYSTEM_PROMPT;
    if (context) system += `\n\n<operator_context>\n${context}\n</operator_context>`;
    if (retrieved) system += `\n\n<materials>\n${retrieved}\n</materials>`;
    return system;
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
