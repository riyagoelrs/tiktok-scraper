import { contextBridge, ipcRenderer } from 'electron';
import type { AnswerPatch, Status, TranscriptLine } from '../shared/types';

const api = {
  onStatus: (cb: (status: Status) => void) =>
    ipcRenderer.on('ui:status', (_e, status: Status) => cb(status)),
  onTranscript: (cb: (line: TranscriptLine) => void) =>
    ipcRenderer.on('ui:transcript', (_e, line: TranscriptLine) => cb(line)),
  onAnswer: (cb: (patch: AnswerPatch) => void) =>
    ipcRenderer.on('ui:answer', (_e, patch: AnswerPatch) => cb(patch)),
  onClear: (cb: () => void) => ipcRenderer.on('ui:clear', () => cb()),

  ready: () => ipcRenderer.send('ctl:ready'),
  toggleListen: () => ipcRenderer.send('ctl:toggle-listen'),
  answerNow: () => ipcRenderer.send('ctl:answer-now'),
  toggleAuto: () => ipcRenderer.send('ctl:toggle-auto'),
  clear: () => ipcRenderer.send('ctl:clear'),
  setClickThrough: (enabled: boolean) => ipcRenderer.send('ctl:click-through', enabled),
  openContext: () => ipcRenderer.send('ctl:open-context'),
  quit: () => ipcRenderer.send('ctl:quit'),
};

export type OverlayApi = typeof api;

contextBridge.exposeInMainWorld('cluely', api);
