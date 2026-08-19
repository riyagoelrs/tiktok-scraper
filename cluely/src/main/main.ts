import { app, BrowserWindow, globalShortcut, ipcMain, shell } from 'electron';
import { ensureContextFile, loadConfig, type Config } from './config';
import { createSttProvider, type SttProvider, type SttSession } from './stt';
import { Materials } from './materials';
import { Transcript } from './transcript';
import { AnswerEngine } from './answer-engine';
import { looksLikeQuestion, questionKey } from './question-detector';
import { createCaptureWindow, createOverlayWindow, installMediaHandlers } from './windows';
import type { AnswerPatch, CaptureState, Speaker, Status, TranscriptLine } from '../shared/types';

// macOS routes loopback audio through ScreenCaptureKit, and Chromium keeps that
// path behind feature flags. Without these, getDisplayMedia returns a stream with
// no audio track on macOS and the THEM channel stays permanently silent.
// Must run before the app is ready, hence the top-level placement.
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch(
    'enable-features',
    'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride',
  );
}

/** Wait this long after a question before answering, so follow-on clauses land first. */
const ANSWER_DEBOUNCE_MS = 900;
/** Don't re-answer the same question if it comes round again within this window. */
const DEDUPE_MS = 30_000;

class App {
  private readonly cfg: Config;
  private readonly provider: SttProvider;
  private readonly transcript: Transcript;
  private readonly materials: Materials;
  private readonly answers: AnswerEngine;

  private overlay: BrowserWindow | undefined;
  private capture: BrowserWindow | undefined;

  private sessions = new Map<Speaker, SttSession>();
  private status: Status;
  private pending: { question: string; timer: NodeJS.Timeout } | undefined;
  private answered = new Map<string, number>();
  private wired = false;

  constructor() {
    this.cfg = loadConfig();
    this.provider = createSttProvider(this.cfg);
    this.transcript = new Transcript((line) => this.send('ui:transcript', line));
    this.materials = new Materials(this.cfg);
    this.answers = new AnswerEngine(this.cfg, this.transcript, this.materials, (patch) =>
      this.send('ui:answer', patch),
    );
    this.status = {
      state: 'idle',
      mic: { capturing: false, stt: 'down' },
      system: { capturing: false, stt: 'down' },
      autoAnswer: this.cfg.autoAnswer,
      clickThrough: false,
    };
  }

  start(): void {
    installMediaHandlers();
    this.overlay = createOverlayWindow(this.cfg);
    this.capture = createCaptureWindow();

    this.overlay.on('closed', () => {
      this.overlay = undefined;
      app.quit();
    });

    // On macOS the app can be reactivated after its windows close; the IPC
    // handlers and hotkeys survive that, so only bind them once.
    if (!this.wired) {
      this.registerIpc();
      this.registerShortcuts();
      this.wired = true;
    }
  }

  // ---------------------------------------------------------------- listening

  private startListening(): void {
    if (this.status.state === 'listening' || this.status.state === 'starting') return;

    try {
      this.openSession('me');
      this.openSession('them');
    } catch (err) {
      this.closeSessions();
      this.status.state = 'error';
      this.pushStatus({ message: err instanceof Error ? err.message : String(err) });
      return;
    }

    this.status.state = 'starting';
    this.pushStatus({ message: undefined });
    this.capture?.webContents.send('capture:start', {
      systemAudioDevice: (process.env.SYSTEM_AUDIO_DEVICE ?? '').trim(),
    });
  }

  private stopListening(): void {
    this.capture?.webContents.send('capture:stop');
    this.closeSessions();
    this.cancelPending();
    this.answers.cancel();
    this.status.state = 'idle';
    this.status.mic = { capturing: false, stt: 'down' };
    this.status.system = { capturing: false, stt: 'down' };
    this.pushStatus();
  }

  private openSession(speaker: Speaker): void {
    const label = speaker === 'me' ? 'mic' : 'system';
    const session = this.provider.open(label, {
      onPartial: (text) => this.transcript.partial(speaker, text),
      onFinal: (text) => this.onFinalUtterance(speaker, text),
      onState: (state, error) => {
        this.sourceStatus(speaker).stt = state;
        this.sourceStatus(speaker).error = error;
        this.pushStatus();
      },
    });
    this.sessions.set(speaker, session);
  }

  private closeSessions(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  private sourceStatus(speaker: Speaker) {
    return speaker === 'me' ? this.status.mic : this.status.system;
  }

  // ----------------------------------------------------------------- answering

  private onFinalUtterance(speaker: Speaker, text: string): void {
    const line = this.transcript.commit(speaker, text);
    if (speaker !== 'them') return;
    if (!this.status.autoAnswer) return;
    if (!looksLikeQuestion(line.text)) return;
    this.scheduleAnswer(line.text);
  }

  /**
   * People ask a question and then keep talking ("...what's your stack? Like,
   * what's the database?"). Debounce so those merge into one answer.
   */
  private scheduleAnswer(question: string): void {
    const merged = this.pending ? `${this.pending.question} ${question}` : question;
    this.cancelPending();
    const timer = setTimeout(() => {
      this.pending = undefined;
      this.runAnswer(merged, 'auto');
    }, ANSWER_DEBOUNCE_MS);
    this.pending = { question: merged, timer };
  }

  private cancelPending(): void {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = undefined;
  }

  private runAnswer(question: string, trigger: 'auto' | 'manual'): void {
    const key = questionKey(question);
    const now = Date.now();
    for (const [seen, at] of this.answered) {
      if (now - at > DEDUPE_MS) this.answered.delete(seen);
    }
    if (trigger === 'auto' && key && this.answered.has(key)) return;
    if (key) this.answered.set(key, now);

    void this.answers.answer({ question, trigger });
  }

  /** Hotkey path: answer whatever they last said, question-shaped or not. */
  private answerNow(): void {
    this.cancelPending();
    const last = this.transcript.lastFrom('them');
    this.runAnswer(last?.text ?? '', 'manual');
  }

  // ----------------------------------------------------------------------- ipc

  private registerIpc(): void {
    ipcMain.on('audio:chunk', (_event, source: Speaker, chunk: ArrayBuffer) => {
      this.sessions.get(source)?.send(Buffer.from(chunk));
    });

    ipcMain.on('capture:state', (_event, state: CaptureState) => {
      const target = this.sourceStatus(state.source);
      target.capturing = state.capturing;
      target.error = state.error;
      const anyCapturing = this.status.mic.capturing || this.status.system.capturing;
      if (anyCapturing) this.status.state = 'listening';
      else if (this.status.mic.error || this.status.system.error) this.status.state = 'error';
      else if (this.status.state === 'listening') this.status.state = 'idle';
      this.pushStatus();
    });

    // The overlay asks for state once it has mounted, so there is no race with load.
    ipcMain.on('ctl:ready', () => {
      this.pushStatus({ message: this.setupProblem() });
      void this.reloadMaterials();
    });

    ipcMain.on('ctl:reload-materials', () => void this.reloadMaterials());
    ipcMain.on('ctl:open-materials', () => {
      void shell.openPath(this.materials.ensureDir());
    });

    ipcMain.on('ctl:toggle-listen', () => this.toggleListening());
    ipcMain.on('ctl:answer-now', () => this.answerNow());
    ipcMain.on('ctl:toggle-auto', () => {
      this.status.autoAnswer = !this.status.autoAnswer;
      this.pushStatus();
    });
    ipcMain.on('ctl:clear', () => {
      this.transcript.clear();
      this.answered.clear();
      this.cancelPending();
      this.answers.cancel();
      this.send('ui:clear');
    });
    ipcMain.on('ctl:click-through', (_event, enabled: boolean) => {
      this.status.clickThrough = enabled;
      this.overlay?.setIgnoreMouseEvents(enabled, { forward: true });
      this.pushStatus();
    });
    ipcMain.on('ctl:open-context', () => {
      void shell.openPath(ensureContextFile(this.cfg));
    });
    ipcMain.on('ctl:quit', () => app.quit());
  }

  /** Configuration problems worth interrupting the user about, before a call starts. */
  private setupProblem(): string | undefined {
    if (this.cfg.sttProvider === 'whisper' && !this.cfg.whisperModel) {
      return 'WHISPER_MODEL is not set — point it at a ggml model file (see the README).';
    }
    if (this.cfg.sttProvider === 'deepgram' && !this.cfg.deepgramApiKey) {
      return 'DEEPGRAM_API_KEY is not set — add it to .env.';
    }
    if (this.cfg.answerProvider === 'claude' && !this.cfg.anthropicApiKey) {
      return 'ANTHROPIC_API_KEY is not set — add it to .env, or set ANSWER_PROVIDER=ollama.';
    }
    return undefined;
  }

  private async reloadMaterials(): Promise<void> {
    await this.materials.load();
    const { files, chunks, embedded, error } = this.materials.stats();
    this.pushStatus({
      materials: files
        ? `${files} file${files === 1 ? '' : 's'}, ${chunks} passages${embedded ? ', semantic' : ''}`
        : 'none',
      message: error ?? this.setupProblem(),
    });
  }

  private toggleListening(): void {
    if (this.status.state === 'idle' || this.status.state === 'error') this.startListening();
    else this.stopListening();
  }

  private registerShortcuts(): void {
    const bindings: Array<[string, () => void]> = [
      ['CommandOrControl+Shift+L', () => this.toggleListening()],
      ['CommandOrControl+Shift+Space', () => this.answerNow()],
      ['CommandOrControl+Shift+H', () => this.toggleOverlay()],
      ['CommandOrControl+Shift+K', () => ipcMain.emit('ctl:clear')],
      ['CommandOrControl+Shift+Left', () => this.nudgeOverlay(-60, 0)],
      ['CommandOrControl+Shift+Right', () => this.nudgeOverlay(60, 0)],
    ];

    for (const [accelerator, handler] of bindings) {
      // A busy machine may already own one of these; a failed binding is not fatal.
      if (!globalShortcut.register(accelerator, handler)) {
        console.warn(`[cluely] could not register hotkey ${accelerator}`);
      }
    }
  }

  private toggleOverlay(): void {
    if (!this.overlay) return;
    if (this.overlay.isVisible()) this.overlay.hide();
    else this.overlay.showInactive();
  }

  private nudgeOverlay(dx: number, dy: number): void {
    if (!this.overlay) return;
    const [x, y] = this.overlay.getPosition();
    this.overlay.setPosition(x + dx, y + dy);
  }

  // -------------------------------------------------------------------- output

  private send(channel: string, payload?: TranscriptLine | AnswerPatch | Status): void {
    if (this.overlay && !this.overlay.isDestroyed()) {
      this.overlay.webContents.send(channel, payload);
    }
  }

  private pushStatus(patch: Partial<Status> = {}): void {
    this.status = { ...this.status, ...patch };
    this.send('ui:status', this.status);
  }

  shutdown(): void {
    globalShortcut.unregisterAll();
    this.closeSessions();
    this.answers.cancel();
  }
}

// Only one copy may hold the hotkeys and the audio devices.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const instance = new App();

  app.whenReady().then(() => {
    instance.start();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) instance.start();
    });
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => instance.shutdown());
}
