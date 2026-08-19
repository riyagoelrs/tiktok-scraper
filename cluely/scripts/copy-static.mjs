// Copies the non-TypeScript renderer assets into dist/renderer.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(root, 'src', 'renderer');
const to = join(root, 'dist', 'renderer');
const STATIC = new Set(['.html', '.css']);

mkdirSync(to, { recursive: true });

for (const name of readdirSync(from)) {
  // pcm-worklet.js is hand-written JS (it runs on the audio thread, untouched by tsc).
  if (STATIC.has(extname(name)) || name === 'pcm-worklet.js') {
    cpSync(join(from, name), join(to, name));
  }
}

console.log(`[cluely] static assets -> ${to}`);
