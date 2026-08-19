import { contextBridge, ipcRenderer } from 'electron';
import type { CaptureState, Speaker } from '../shared/types';

export interface CaptureStartOptions {
  /** When set, system audio is read from this input device instead of loopback. */
  systemAudioDevice: string;
}

const api = {
  onStart: (cb: (options: CaptureStartOptions) => void) =>
    ipcRenderer.on('capture:start', (_e, options: CaptureStartOptions) => cb(options)),
  onStop: (cb: () => void) => ipcRenderer.on('capture:stop', () => cb()),
  sendChunk: (source: Speaker, pcm: ArrayBuffer) => ipcRenderer.send('audio:chunk', source, pcm),
  reportState: (state: CaptureState) => ipcRenderer.send('capture:state', state),
};

export type CaptureApi = typeof api;

contextBridge.exposeInMainWorld('capture', api);
