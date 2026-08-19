# cluely

A desktop copilot for live calls. It listens to **both** sides — your microphone and
the audio your machine is playing — transcribes each stream separately, and when the
other person asks something, an answer appears in a floating overlay before they've
finished the sentence.

<!-- run `npm run smoke` to regenerate dist/smoke.png -->

```
 mic ─────────────► Deepgram stream (ME)   ─┐
                                            ├─► transcript ─► question? ─► Claude ─► overlay
 system loopback ─► Deepgram stream (THEM) ─┘
```

Two independent transcription sessions is what makes this work: speaker attribution
comes from *which device the audio came from*, not from diarization, so it is exact
and it is free.

## Setup

Requires Node 20+.

```bash
cd cluely
npm install
cp .env.example .env      # add ANTHROPIC_API_KEY and DEEPGRAM_API_KEY
cp context.example.md context.md   # optional but this is what makes answers good
npm start
```

`npm start` builds and launches. `npm test` runs the logic tests (no Electron needed).

## Using it

Hit **Listen**, then join your call as normal. Question-shaped things the other side
says get answered automatically; everything else just scrolls past in the transcript
strip at the bottom.

| Hotkey | Does |
|---|---|
| `⌘/Ctrl+Shift+L` | Start / stop listening |
| `⌘/Ctrl+Shift+Space` | Answer whatever they just said, right now |
| `⌘/Ctrl+Shift+H` | Hide / show the overlay |
| `⌘/Ctrl+Shift+K` | Clear transcript and answers |
| `⌘/Ctrl+Shift+←/→` | Nudge the overlay sideways |

Buttons in the title bar: **Auto** toggles automatic answering, **Ghost** makes the
overlay click-through (it stops intercepting your mouse — move the pointer over the
title bar to get it back), **Notes** opens your `context.md`.

The overlay sets `setContentProtection(true)`, so it stays out of screen shares and
screenshots — your own notes don't end up on the shared screen. `CONTENT_PROTECTION=false`
in `.env` turns that off (useful when debugging, since screenshots come back blank).

Treat this as a courtesy, not a guarantee: on macOS 15.4+ some modern capture APIs can
see through it, and no window flag has ever stopped a phone camera.

### context.md is the whole game

Without it you get generic answers. With three bullets about who you are and what the
call is about, you get answers you can actually say out loud. It is re-read from disk
on every answer, so you can edit it mid-call and the next answer picks it up.

## System audio

Capturing the *other* person means capturing what your machine plays. How that works
depends on the OS:

- **Windows** — works out of the box. Electron's `getDisplayMedia` loopback grabs
  system audio directly.
- **macOS** — needs **macOS 14.4+**, and you must grant Screen Recording permission
  (System Settings → Privacy & Security → Screen Recording). Loopback goes through
  ScreenCaptureKit, which Chromium keeps behind two feature flags; the app enables
  `MacLoopbackAudioForScreenShare` and `MacSckSystemAudioLoopbackOverride` at startup
  so you don't have to. Below 14.4, or if loopback still comes back silent, install a
  virtual audio device such as [BlackHole](https://github.com/ExistentialAudio/BlackHole),
  route your call app's output through a Multi-Output Device that includes it, and set
  `SYSTEM_AUDIO_DEVICE=BlackHole` in `.env`.
- **Linux** — loopback support varies by desktop and portal. The reliable path is a
  PulseAudio/PipeWire monitor source: `SYSTEM_AUDIO_DEVICE=Monitor of`.

If the **THEM** chip in the title bar never turns green, that is the thing to fix
first — hover it for the underlying error.

Your mic is captured with echo cancellation on. Without it the mic re-records the
other person coming out of your speakers and both transcripts say the same thing.
**Use headphones anyway** — it is more reliable than any AEC.

## Configuration

Everything lives in `.env`; see `.env.example` for the annotated list. The knobs that
matter most:

| Variable | Default | Why you'd change it |
|---|---|---|
| `ANSWER_EFFORT` | `low` | Raise to `medium`/`high` for harder questions, at the cost of a slower answer |
| `ANSWER_THINKING` | `off` | `adaptive` reasons before answering — better on tangled questions, slower |
| `AUTO_ANSWER` | `true` | `false` makes every answer manual (`⌘/Ctrl+Shift+Space`) |
| `CONTEXT_LINES` | `24` | How much conversation history Claude sees per question |
| `SYSTEM_AUDIO_DEVICE` | *(empty)* | Virtual-cable name, when loopback isn't available |

Latency is a product decision here: the defaults trade some depth for speed, because a
brilliant answer that arrives after the topic moved on is worth nothing on a live call.

## How it's put together

```
src/main/          Electron main process — owns audio routing, STT sockets, and Claude
  main.ts            wiring: IPC, hotkeys, the auto-answer decision
  stt/               streaming speech-to-text behind a provider interface
  transcript.ts      rolling record, one in-flight partial per speaker
  question-detector.ts  local heuristic: "did they just ask me something?"
  answer-engine.ts   prompt construction + streamed Claude call
  windows.ts         overlay + hidden capture window, loopback media handler
src/renderer/
  capture.ts         the audio graph (getUserMedia + getDisplayMedia -> 16 kHz PCM)
  overlay.*          the floating UI
src/preload/       the only bridge between the two; context isolation stays on
```

Audio never touches disk. It goes mic/loopback → AudioWorklet → 16 kHz mono PCM →
IPC → Deepgram socket, and the only thing retained is text.

Swapping the transcription engine means implementing `SttProvider` in `src/main/stt/`
and adding a case to `createSttProvider` — nothing upstream knows which engine is running.

## Prior art

This problem has been solved several times over, and the versions worth reading differ
in ways that shaped the choices here:

- **[pickle-com/glass](https://github.com/pickle-com/glass)** — the original open-source
  build of this idea; the reference most later projects fork from.
- **[cue](https://github.com/Blueturboguy07/cue)** — macOS-focused, and the source of the
  ScreenCaptureKit flag detail above. Also the most honest about where invisibility stops
  working.
- **[Natively](https://github.com/Natively-AI-assistant/natively-cluely-ai-assistant)** —
  the maximal version: a Rust native module for capture, local Whisper/Moonshine models,
  local RAG, and a long list of BYOK providers. Worth reading if you ever want this to run
  fully offline; note it has no Linux support.
- **[Open-Cluely](https://github.com/shubhamshnd/Open-Cluely)** — Electron + AssemblyAI +
  Gemini, Windows-first. Notably it does *not* auto-detect questions: every answer is a
  button press.

Where this one differs: answers fire automatically off a local question heuristic rather
than a hotkey, speaker attribution comes from running two independent STT sessions rather
than diarization, and the whole thing is small enough to read in one sitting.

## Before you use this on a real call

Recording a conversation you are part of is legal in much of the world and illegal
without the other side's consent in plenty of it — all-party-consent jurisdictions
include California, Florida, Illinois, Pennsylvania, and much of the EU. This app makes
a recording (in memory) and sends it to two third parties (Deepgram, Anthropic). Say so
at the top of the call. "I've got an AI assistant taking notes" costs three seconds and
solves the whole problem.

Some contexts have their own rules regardless of the law — proctored exams and many
technical interviews prohibit assistance outright. Being undetectable is not the same
as being permitted.
