import * as path from 'node:path';
import { BrowserWindow, desktopCapturer, screen, session } from 'electron';
import type { Config } from './config';

const OVERLAY_WIDTH = 480;
const OVERLAY_HEIGHT = 640;
const MARGIN = 24;

export function createOverlayWindow(cfg: Config): BrowserWindow {
  const work = screen.getPrimaryDisplay().workArea;

  const win = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: Math.min(OVERLAY_HEIGHT, work.height - MARGIN * 2),
    x: work.x + work.width - OVERLAY_WIDTH - MARGIN,
    y: work.y + MARGIN,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    fullscreenable: false,
    // Focusable so its buttons and text selection work; it is shown with
    // showInactive() below so it never steals focus from the call app.
    focusable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // 'screen-saver' keeps the overlay above full-screen call windows.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Excludes the overlay from screen shares and screenshots, so your own notes
  // don't end up on the shared screen. Set CONTENT_PROTECTION=false to disable.
  win.setContentProtection(cfg.contentProtection);

  void win.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
  win.once('ready-to-show', () => win.showInactive());

  return win;
}

/**
 * Hidden window whose only job is to hold the audio graph. getUserMedia and
 * getDisplayMedia are renderer-only APIs, so capture cannot live in main.
 */
export function createCaptureWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 320,
    height: 200,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'capture-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // A hidden window is throttled by default, which would stall the audio graph.
      backgroundThrottling: false,
    },
  });

  void win.loadFile(path.join(__dirname, '..', 'renderer', 'capture.html'));
  return win;
}

/**
 * Route getDisplayMedia to the primary screen with loopback audio, so the
 * capture window receives what the machine is playing (i.e. the other person)
 * without a picker dialog appearing mid-call.
 */
export function installMediaHandlers(): void {
  const s = session.defaultSession;

  s.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          const screenSource = sources[0];
          if (!screenSource) {
            callback({ video: undefined, audio: undefined });
            return;
          }
          callback({ video: screenSource, audio: 'loopback' });
        })
        .catch(() => callback({ video: undefined, audio: undefined }));
    },
    // The system picker would prompt on every start; we always want the same thing.
    { useSystemPicker: false },
  );

  s.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'media' || permission === 'display-capture');
  });
}
