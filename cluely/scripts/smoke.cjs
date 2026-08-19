// Dev smoke check: boots the overlay, pushes fake status/transcript/answer traffic
// through the real IPC channels, screenshots it, and exits.
//   npm run smoke   ->  dist/smoke.png
const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');

process.env.CONTENT_PROTECTION = 'false'; // otherwise capturePage() may come back blank

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const { loadConfig } = require('../dist/main/config.js');
  const { createOverlayWindow } = require('../dist/main/windows.js');

  const win = createOverlayWindow(loadConfig());
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));

  const send = (channel, payload) => win.webContents.send(channel, payload);

  send('ui:status', {
    state: 'listening',
    mic: { capturing: true, stt: 'up' },
    system: { capturing: true, stt: 'up' },
    autoAnswer: true,
    clickThrough: false,
  });

  send('ui:answer', {
    id: 'a1',
    question: 'How would you keep the transcript from drifting out of sync with the audio?',
    status: 'thinking',
    trigger: 'auto',
    at: Date.now(),
  });
  await wait(200);
  send('ui:answer', {
    id: 'a1',
    status: 'streaming',
    append:
      '- Timestamp every chunk at capture, not at send\n' +
      '- Let the STT engine own ordering; never re-sort locally\n' +
      '- Drop audio rather than queue it if the socket backs up\n' +
      '- Reconnects replay at most ~10s, so a blip costs a sentence, not the call',
  });
  send('ui:answer', { id: 'a1', status: 'done' });

  send('ui:transcript', { id: 't1', speaker: 'them', text: 'So walk me through the audio path.', final: true, at: Date.now() });
  send('ui:transcript', { id: 't2', speaker: 'me', text: 'Sure — two streams, mic and loopback.', final: true, at: Date.now() });
  send('ui:transcript', { id: 't3', speaker: 'them', text: 'and how do you keep them from', final: false, at: Date.now() });

  send('ui:status', {
    state: 'listening',
    mic: { capturing: true, stt: 'up' },
    system: { capturing: true, stt: 'up' },
    autoAnswer: true,
    clickThrough: false,
    materials: '6 files, 41 passages, semantic',
  });

  await wait(700);

  // Exercise the real screen-capture path the Screen hotkey uses.
  const { captureScreen } = require('../dist/main/screen.js');
  try {
    const shot = await captureScreen(640);
    const png = Buffer.from(shot, 'base64');
    const isPng = png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    console.log(`[cluely] screen capture: ${png.length} bytes, valid PNG: ${isPng}`);
    if (!isPng) process.exitCode = 1;
  } catch (err) {
    console.log(`[cluely] screen capture FAILED: ${err.message}`);
    process.exitCode = 1;
  }

  const image = await win.webContents.capturePage();
  const out = path.join(__dirname, '..', 'dist', 'smoke.png');
  fs.writeFileSync(out, image.toPNG());
  console.log(`[cluely] smoke screenshot -> ${out}`);

  app.quit();
});
