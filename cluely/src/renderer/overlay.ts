import type { AnswerPatch, Status, TranscriptLine } from '../shared/types';

interface OverlayApi {
  onStatus(cb: (status: Status) => void): void;
  onTranscript(cb: (line: TranscriptLine) => void): void;
  onAnswer(cb: (patch: AnswerPatch) => void): void;
  onClear(cb: () => void): void;
  ready(): void;
  toggleListen(): void;
  answerNow(): void;
  toggleAuto(): void;
  clear(): void;
  setClickThrough(enabled: boolean): void;
  openContext(): void;
  openMaterials(): void;
  reloadMaterials(): void;
  quit(): void;
}

declare global {
  interface Window {
    cluely: OverlayApi;
  }
}

const MAX_TRANSCRIPT_LINES = 40;
const MAX_CARDS = 30;

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
};

const answersEl = el('answers');
const transcriptEl = el('transcript');
const emptyEl = el('empty');
const noticeEl = el('notice');
const recEl = el('rec');
const chipMic = el('chip-mic');
const chipSys = el('chip-sys');
const btnListen = el<HTMLButtonElement>('btn-listen');
const btnAuto = el<HTMLButtonElement>('btn-auto');
const btnGhost = el<HTMLButtonElement>('btn-ghost');
const chipDocs = el('chip-docs');

interface CardNodes {
  root: HTMLElement;
  question: HTMLElement;
  body: HTMLElement;
}

const cards = new Map<string, CardNodes>();
const lines = new Map<string, HTMLElement>();
let ghost = false;

// ------------------------------------------------------------------ answers

function ensureCard(patch: AnswerPatch): CardNodes {
  const existing = cards.get(patch.id);
  if (existing) return existing;

  emptyEl.hidden = true;

  const root = document.createElement('article');
  root.className = 'card';
  root.dataset.status = patch.status ?? 'thinking';

  const question = document.createElement('div');
  question.className = 'q';
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = patch.trigger === 'manual' ? 'ASKED' : 'THEM';
  const qtext = document.createElement('span');
  qtext.className = 'text';
  qtext.textContent = patch.question ?? '';
  question.append(tag, qtext);

  const body = document.createElement('div');
  body.className = 'a dots';

  root.append(question, body);
  answersEl.prepend(root);

  const nodes: CardNodes = { root, question: qtext, body };
  cards.set(patch.id, nodes);

  // Newest first; drop the tail so a long call doesn't grow the DOM forever.
  while (answersEl.querySelectorAll('.card').length > MAX_CARDS) {
    const last = answersEl.querySelector('.card:last-of-type');
    if (!last) break;
    for (const [id, card] of cards) {
      if (card.root === last) cards.delete(id);
    }
    last.remove();
  }

  return nodes;
}

function applyAnswer(patch: AnswerPatch): void {
  const card = ensureCard(patch);
  if (patch.question !== undefined) card.question.textContent = patch.question;
  if (patch.body !== undefined) card.body.textContent = patch.body;
  if (patch.append) card.body.textContent = `${card.body.textContent ?? ''}${patch.append}`;
  if (patch.status) {
    card.root.dataset.status = patch.status;
    card.body.classList.toggle('dots', patch.status === 'thinking');
  }
  answersEl.scrollTop = 0;
}

// --------------------------------------------------------------- transcript

function applyTranscript(line: TranscriptLine): void {
  let node = lines.get(line.id);
  if (!node) {
    node = document.createElement('div');
    node.className = 'line';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = line.speaker === 'me' ? 'ME' : 'THEM';
    const said = document.createElement('span');
    said.className = 'said';
    node.append(who, said);
    transcriptEl.append(node);
    lines.set(line.id, node);
  }

  node.dataset.speaker = line.speaker;
  node.dataset.final = String(line.final);
  const said = node.querySelector('.said');
  if (said) said.textContent = line.text;

  while (transcriptEl.children.length > MAX_TRANSCRIPT_LINES) {
    const first = transcriptEl.firstElementChild;
    if (!first) break;
    for (const [id, el2] of lines) {
      if (el2 === first) lines.delete(id);
    }
    first.remove();
  }

  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// ------------------------------------------------------------------- status

function applyStatus(status: Status): void {
  recEl.dataset.state = status.state;
  btnListen.textContent = status.state === 'idle' || status.state === 'error' ? 'Listen' : 'Stop';
  btnListen.dataset.on = String(status.state === 'listening' || status.state === 'starting');
  btnAuto.dataset.on = String(status.autoAnswer);
  btnGhost.dataset.on = String(status.clickThrough);

  chipMic.dataset.live = status.mic.error ? 'error' : String(status.mic.capturing && status.mic.stt === 'up');
  chipSys.dataset.live = status.system.error ? 'error' : String(status.system.capturing && status.system.stt === 'up');
  chipMic.title = status.mic.error ?? `mic: ${status.mic.capturing ? 'capturing' : 'off'} / stt ${status.mic.stt}`;
  chipSys.title = status.system.error ?? `system: ${status.system.capturing ? 'capturing' : 'off'} / stt ${status.system.stt}`;

  const indexed = status.materials && status.materials !== 'none';
  chipDocs.dataset.live = String(Boolean(indexed));
  chipDocs.title = indexed
    ? `Materials indexed: ${status.materials} — click to re-index`
    : 'No materials indexed — click "Docs" to open the folder';

  const problem = status.message ?? status.mic.error ?? status.system.error;
  noticeEl.textContent = problem ?? '';
  noticeEl.hidden = !problem;
}

// ------------------------------------------------------------------- wiring

window.cluely.onAnswer(applyAnswer);
window.cluely.onTranscript(applyTranscript);
window.cluely.onStatus(applyStatus);
window.cluely.onClear(() => {
  cards.clear();
  lines.clear();
  for (const card of Array.from(answersEl.querySelectorAll('.card'))) card.remove();
  transcriptEl.replaceChildren();
  emptyEl.hidden = false;
});

btnListen.addEventListener('click', () => window.cluely.toggleListen());
btnAuto.addEventListener('click', () => window.cluely.toggleAuto());
el('btn-clear').addEventListener('click', () => window.cluely.clear());
el('btn-context').addEventListener('click', () => window.cluely.openContext());
el('btn-materials').addEventListener('click', () => window.cluely.openMaterials());
// Re-index after editing the folder without restarting the app.
chipDocs.addEventListener('click', () => window.cluely.reloadMaterials());
btnGhost.addEventListener('click', () => {
  ghost = !ghost;
  window.cluely.setClickThrough(ghost);
});

// Ghost mode makes the whole window click-through, including this button, so
// give the header back its clicks whenever the pointer is over it.
el('rec').closest('.bar')?.addEventListener('mouseenter', () => {
  if (ghost) window.cluely.setClickThrough(false);
});
document.addEventListener('mouseleave', () => {
  if (ghost) window.cluely.setClickThrough(true);
});

// Listeners are attached; ask main for the current state.
window.cluely.ready();
