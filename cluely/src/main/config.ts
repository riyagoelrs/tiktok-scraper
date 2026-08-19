import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as dotenv from 'dotenv';

export type ThinkingMode = 'off' | 'adaptive';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface Config {
  anthropicApiKey: string;
  deepgramApiKey: string;
  deepgramModel: string;
  /** Overridable so the self-tests can point the client at a local server. */
  deepgramEndpoint: string;
  language: string;
  /** Claude model used to draft answers. */
  answerModel: string;
  answerEffort: Effort;
  answerThinking: ThinkingMode;
  answerMaxTokens: number;
  /** Answer automatically when the other side asks something question-shaped. */
  autoAnswer: boolean;
  /** How many transcript lines are handed to Claude as conversation context. */
  contextLines: number;
  /** Keep the overlay out of screen shares and screenshots. */
  contentProtection: boolean;
  /** Where the operator's background notes live (resume, product facts, ...). */
  contextFile: string;
  appRoot: string;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  const v = (value ?? '').trim().toLowerCase() as T;
  return allowed.includes(v) ? v : fallback;
}

/**
 * The directory the app was started from. In development that is the project
 * root; in a packaged build it is the resources directory next to the asar.
 */
function resolveAppRoot(): string {
  return app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath();
}

function resolveContextFile(appRoot: string): string {
  const candidates = [
    process.env.CLUELY_CONTEXT,
    path.join(appRoot, 'context.md'),
    path.join(app.getPath('userData'), 'context.md'),
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // Nothing exists yet — point at the user-data copy so "Edit context" can create it.
  return path.join(app.getPath('userData'), 'context.md');
}

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) return cached;

  const appRoot = resolveAppRoot();
  // .env next to the app wins; a .env in the user-data dir is the fallback for
  // packaged builds where the app directory is read-only.
  for (const envPath of [path.join(appRoot, '.env'), path.join(app.getPath('userData'), '.env')]) {
    if (fs.existsSync(envPath)) dotenv.config({ path: envPath });
  }

  cached = {
    anthropicApiKey: (process.env.ANTHROPIC_API_KEY ?? '').trim(),
    deepgramApiKey: (process.env.DEEPGRAM_API_KEY ?? '').trim(),
    deepgramModel: (process.env.DEEPGRAM_MODEL ?? 'nova-3').trim(),
    deepgramEndpoint: (process.env.DEEPGRAM_URL ?? 'wss://api.deepgram.com/v1/listen').trim(),
    language: (process.env.STT_LANGUAGE ?? 'en').trim(),
    answerModel: (process.env.ANSWER_MODEL ?? 'claude-opus-5').trim(),
    answerEffort: oneOf(process.env.ANSWER_EFFORT, ['low', 'medium', 'high', 'xhigh', 'max'] as const, 'low'),
    answerThinking: oneOf(process.env.ANSWER_THINKING, ['off', 'adaptive'] as const, 'off'),
    answerMaxTokens: int(process.env.ANSWER_MAX_TOKENS, 1200),
    autoAnswer: bool(process.env.AUTO_ANSWER, true),
    contextLines: int(process.env.CONTEXT_LINES, 24),
    contentProtection: bool(process.env.CONTENT_PROTECTION, true),
    contextFile: resolveContextFile(appRoot),
    appRoot,
  };
  return cached;
}

/** Operator background notes, re-read from disk on every answer so edits apply live. */
export function readOperatorContext(cfg: Config): string {
  try {
    return fs.readFileSync(cfg.contextFile, 'utf8').trim();
  } catch {
    return '';
  }
}

export function ensureContextFile(cfg: Config): string {
  if (!fs.existsSync(cfg.contextFile)) {
    fs.mkdirSync(path.dirname(cfg.contextFile), { recursive: true });
    fs.writeFileSync(
      cfg.contextFile,
      [
        '# Context for the copilot',
        '',
        'Anything here is given to Claude on every answer. Keep it short and factual.',
        '',
        '## Who I am',
        '- ',
        '',
        '## What we are talking about',
        '- ',
        '',
        '## Facts I keep forgetting',
        '- ',
        '',
      ].join('\n'),
      'utf8',
    );
  }
  return cfg.contextFile;
}
