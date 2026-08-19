import type { Config } from '../config';
import type { AnswerProvider, GenerateRequest } from './types';

interface OllamaChunk {
  message?: { content?: string };
  done?: boolean;
  error?: string;
}

/**
 * Answers from a model running on this machine via Ollama. No API key, no
 * network egress — which is the whole point: your materials never leave the
 * laptop, so there is no third party to disclose.
 */
export class OllamaProvider implements AnswerProvider {
  readonly name = 'ollama';

  constructor(private readonly cfg: Config) {}

  async generate(request: GenerateRequest): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.cfg.ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          // A screenshot needs a multimodal model; the text model would ignore it.
          model: request.image ? this.cfg.ollamaVisionModel : this.cfg.ollamaModel,
          stream: true,
          messages: [
            { role: 'system', content: request.system },
            {
              role: 'user',
              content: request.user,
              ...(request.image ? { images: [request.image] } : {}),
            },
          ],
          options: {
            // Low temperature: on a live call we want the likeliest answer, not a creative one.
            temperature: 0.3,
            num_predict: request.maxTokens,
          },
        }),
        signal: request.signal,
      });
    } catch (err) {
      if (request.signal.aborted) throw err;
      throw new Error(describeConnectionError(err, this.cfg.ollamaUrl));
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 400);
      if (response.status === 404) {
        const model = request.image ? this.cfg.ollamaVisionModel : this.cfg.ollamaModel;
        throw new Error(`Model "${model}" isn't pulled — run: ollama pull ${model}`);
      }
      throw new Error(`Ollama returned ${response.status}: ${detail || response.statusText}`);
    }
    if (!response.body) throw new Error('Ollama returned an empty response body');

    await readNdjson(response.body, (line) => {
      const chunk = JSON.parse(line) as OllamaChunk;
      if (chunk.error) throw new Error(`Ollama: ${chunk.error}`);
      const delta = chunk.message?.content;
      if (delta) request.onDelta(delta);
    });
  }
}

/** Ollama streams newline-delimited JSON; chunks split mid-line, so buffer. */
export async function readNdjson(
  body: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onLine(line);
      newline = buffer.indexOf('\n');
    }
  }
  const tail = buffer.trim();
  if (tail) onLine(tail);
}

const DOWN_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET', 'ETIMEDOUT']);

/**
 * fetch() buries the real reason: the useful code sits on `cause`, and when
 * Node tries several addresses the cause is an AggregateError holding one error
 * per attempt. Walk the whole chain rather than guessing at one shape.
 */
export function errorCodes(err: unknown, depth = 0): string[] {
  if (!err || depth > 4) return [];
  const node = err as { code?: string; cause?: unknown; errors?: unknown[] };
  const codes: string[] = [];
  if (typeof node.code === 'string') codes.push(node.code);
  if (Array.isArray(node.errors)) {
    for (const inner of node.errors) codes.push(...errorCodes(inner, depth + 1));
  }
  if (node.cause) codes.push(...errorCodes(node.cause, depth + 1));
  return codes;
}

export function describeConnectionError(err: unknown, url: string): string {
  const codes = errorCodes(err);
  const message = err instanceof Error ? err.message : String(err);
  // A bare "fetch failed" against localhost means the daemon isn't up — by far
  // the most common failure of a local setup, and the least helpful message.
  if (codes.some((code) => DOWN_CODES.has(code)) || message === 'fetch failed') {
    return `Ollama isn't running at ${url} — start it with: ollama serve`;
  }
  return `Could not reach Ollama at ${url}: ${message}`;
}
