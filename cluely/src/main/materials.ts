import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from './config';

/**
 * Your training materials, searched locally on every question.
 *
 * `context.md` holds a page of facts. This holds everything else: interview
 * prep, product docs, past transcripts, whatever you drop in the folder. Only
 * the handful of passages that match the question go into the prompt, because
 * a live call has no budget for stuffing a whole library through a local model.
 *
 * Retrieval runs keyword-first and always works. Embeddings are an enhancement:
 * when Ollama can produce them, results are re-ranked semantically, and when it
 * can't, keyword scoring still answers. Nothing here touches the network beyond
 * localhost.
 */

const EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.text']);
const CHUNK_CHARS = 900;
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'as', 'by', 'from', 'that', 'this', 'these',
  'those', 'it', 'its', 'we', 'you', 'your', 'i', 'my', 'me', 'do', 'does', 'did', 'how',
  'what', 'why', 'when', 'where', 'who', 'which', 'can', 'could', 'would', 'should', 'about',
]);

export interface Chunk {
  file: string;
  text: string;
  terms: Map<string, number>;
  embedding?: number[];
}

export interface MaterialsStats {
  files: number;
  chunks: number;
  embedded: boolean;
  error?: string;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

/** Split on blank lines, then pack paragraphs up to roughly CHUNK_CHARS. */
export function chunkText(text: string): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > CHUNK_CHARS) {
      chunks.push(current);
      current = '';
    }
    // A paragraph longer than a chunk is split on sentences rather than mid-word.
    if (paragraph.length > CHUNK_CHARS) {
      if (current) { chunks.push(current); current = ''; }
      for (const sentence of paragraph.match(/[^.!?]+[.!?]*\s*/g) ?? [paragraph]) {
        // Tables, pasted logs and code have no sentence boundaries at all, so a
        // hard cut is the only thing that keeps a chunk prompt-sized.
        for (const piece of hardSplit(sentence, CHUNK_CHARS)) {
          if (current.length + piece.length > CHUNK_CHARS && current) { chunks.push(current); current = ''; }
          current += piece;
        }
      }
      continue;
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/** Break an over-long run at a word boundary where possible, mid-run otherwise. */
function hardSplit(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const boundary = window.lastIndexOf(' ');
    const cut = boundary > limit * 0.6 ? boundary + 1 : limit;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) pieces.push(rest);
  return pieces;
}

function termFrequencies(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const term of tokenize(text)) counts.set(term, (counts.get(term) ?? 0) + 1);
  return counts;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export class Materials {
  private chunks: Chunk[] = [];
  private documentFrequency = new Map<string, number>();
  private files = 0;
  private embedded = false;
  private error: string | undefined;
  private loading: Promise<void> | undefined;

  constructor(private readonly cfg: Config) {}

  stats(): MaterialsStats {
    return { files: this.files, chunks: this.chunks.length, embedded: this.embedded, error: this.error };
  }

  /** Re-reads the folder from disk; safe to call whenever it may have changed. */
  async load(): Promise<void> {
    if (!this.loading) this.loading = this.doLoad().finally(() => { this.loading = undefined; });
    return this.loading;
  }

  private async doLoad(): Promise<void> {
    this.error = undefined;
    this.chunks = [];
    this.documentFrequency = new Map();
    this.files = 0;
    this.embedded = false;

    const files = listFiles(this.cfg.materialsDir);
    for (const file of files) {
      let contents: string;
      try {
        contents = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      this.files += 1;
      const label = path.relative(this.cfg.materialsDir, file);
      for (const text of chunkText(contents)) {
        this.chunks.push({ file: label, text, terms: termFrequencies(text) });
      }
    }

    for (const chunk of this.chunks) {
      for (const term of chunk.terms.keys()) {
        this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
      }
    }

    await this.embedAll();
  }

  private async embedAll(): Promise<void> {
    if (!this.cfg.ollamaEmbedModel || !this.chunks.length) return;
    try {
      for (const chunk of this.chunks) {
        chunk.embedding = await this.embed(chunk.text);
      }
      this.embedded = true;
    } catch (err) {
      // Keyword retrieval still works, so this degrades rather than fails.
      this.embedded = false;
      this.error = `Semantic search off (${err instanceof Error ? err.message : String(err)}); using keyword search`;
      for (const chunk of this.chunks) delete chunk.embedding;
    }
  }

  private async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.cfg.ollamaUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.cfg.ollamaEmbedModel, prompt: text }),
    });
    if (!response.ok) {
      throw new Error(
        response.status === 404
          ? `run: ollama pull ${this.cfg.ollamaEmbedModel}`
          : `embeddings returned ${response.status}`,
      );
    }
    const body = (await response.json()) as { embedding?: number[] };
    if (!body.embedding?.length) throw new Error('empty embedding');
    return body.embedding;
  }

  /** Keyword score with an idf weight, so common words don't dominate. */
  private keywordScore(chunk: Chunk, queryTerms: string[]): number {
    const total = Math.max(1, this.chunks.length);
    let score = 0;
    for (const term of queryTerms) {
      const tf = chunk.terms.get(term);
      if (!tf) continue;
      const df = this.documentFrequency.get(term) ?? 1;
      score += (1 + Math.log(tf)) * Math.log(1 + total / df);
    }
    // Normalise by length so a long chunk doesn't win on volume alone.
    return score / Math.sqrt(Math.max(1, chunk.terms.size));
  }

  async retrieve(query: string, topK: number): Promise<Chunk[]> {
    if (!this.chunks.length) return [];
    const queryTerms = tokenize(query);
    if (!queryTerms.length) return [];

    const keyword = this.chunks.map((chunk) => ({ chunk, score: this.keywordScore(chunk, queryTerms) }));

    if (this.embedded) {
      try {
        const queryEmbedding = await this.embed(query);
        const maxKeyword = Math.max(...keyword.map((k) => k.score), 1e-6);
        // Blend: semantics finds paraphrases, keywords anchor on exact jargon.
        for (const entry of keyword) {
          const semantic = entry.chunk.embedding ? cosine(queryEmbedding, entry.chunk.embedding) : 0;
          entry.score = 0.65 * semantic + 0.35 * (entry.score / maxKeyword);
        }
      } catch {
        // Fall through with the keyword scores already computed.
      }
    }

    return keyword
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((entry) => entry.chunk);
  }

  /** The block handed to the model, or empty when nothing matched. */
  async prompt(query: string): Promise<string> {
    const hits = await this.retrieve(query, this.cfg.materialsTopK);
    if (!hits.length) return '';
    return hits.map((hit) => `[${hit.file}]\n${hit.text}`).join('\n\n---\n\n');
  }

  ensureDir(): string {
    if (!fs.existsSync(this.cfg.materialsDir)) {
      fs.mkdirSync(this.cfg.materialsDir, { recursive: true });
      fs.writeFileSync(
        path.join(this.cfg.materialsDir, 'README.md'),
        [
          '# Materials',
          '',
          'Drop .md and .txt files in this folder: interview prep, product notes,',
          'past call transcripts, spec docs, anything you want the copilot to know.',
          '',
          'Only the passages relevant to each question are sent to the model, so it',
          'is fine for this folder to be much larger than a prompt.',
          '',
          'Nothing here leaves your machine when ANSWER_PROVIDER=ollama.',
          '',
        ].join('\n'),
        'utf8',
      );
    }
    return this.cfg.materialsDir;
  }
}

function listFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(full));
    else if (EXTENSIONS.has(path.extname(entry.name).toLowerCase())) found.push(full);
  }
  return found.sort();
}
