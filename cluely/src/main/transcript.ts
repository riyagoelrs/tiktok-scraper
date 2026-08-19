import { randomUUID } from 'node:crypto';
import type { Speaker, TranscriptLine } from '../shared/types';

const MAX_LINES = 400;

/**
 * Rolling record of the call. Each speaker has at most one in-flight (partial)
 * line, which is replaced as the STT engine revises it and then committed.
 */
export class Transcript {
  private lines: TranscriptLine[] = [];
  private partials = new Map<Speaker, TranscriptLine>();

  constructor(private readonly onChange: (line: TranscriptLine) => void) {}

  partial(speaker: Speaker, text: string): void {
    const existing = this.partials.get(speaker);
    const line: TranscriptLine = existing
      ? { ...existing, text }
      : { id: randomUUID(), speaker, text, final: false, at: Date.now() };
    this.partials.set(speaker, line);
    this.onChange(line);
  }

  commit(speaker: Speaker, text: string): TranscriptLine {
    const pending = this.partials.get(speaker);
    this.partials.delete(speaker);
    const line: TranscriptLine = {
      id: pending?.id ?? randomUUID(),
      speaker,
      text,
      final: true,
      at: pending?.at ?? Date.now(),
    };
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
    this.onChange(line);
    return line;
  }

  /** The last `count` finalized lines, oldest first. */
  recent(count: number): TranscriptLine[] {
    return this.lines.slice(-count);
  }

  /** Conversation window formatted for the model. */
  render(count: number): string {
    return this.recent(count)
      .map((line) => `${line.speaker === 'me' ? 'ME' : 'THEM'}: ${line.text}`)
      .join('\n');
  }

  /** Most recent finalized line from the other side, if any. */
  lastFrom(speaker: Speaker): TranscriptLine | undefined {
    for (let i = this.lines.length - 1; i >= 0; i -= 1) {
      const line = this.lines[i];
      if (line.speaker === speaker) return line;
    }
    return undefined;
  }

  clear(): void {
    this.lines = [];
    this.partials.clear();
  }
}
