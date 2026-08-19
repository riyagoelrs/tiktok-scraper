# cluely

A desktop copilot for live calls. It listens to **both** sides — your microphone and
the audio your machine is playing — transcribes each stream separately, and when the
other person asks something, an answer appears in a floating overlay before they've
finished the sentence.

It runs **fully local by default**: Whisper for transcription, Ollama for answers. No
API key, no account, no per-call cost, and nothing — not your call, not your prep
material — leaves your machine.

```
 mic ─────────────► whisper.cpp (ME)   ─┐
                                        ├─► transcript ─► question? ─┐
 system loopback ─► whisper.cpp (THEM) ─┘                            │
                                                                     ▼
                      materials/ ──► retrieve relevant passages ──► Ollama ──► overlay
```

Two independent transcription sessions is what makes this work: speaker attribution
comes from *which device the audio came from*, not from diarization, so it is exact
and it is free.

## Setup

Requires Node 20+. On macOS you also want Apple Silicon with 16GB — a local model
generating answers while Whisper transcribes two streams is a real workload.

**1. Transcription**

```bash
brew install whisper-cpp
# base.en is the sweet spot for live calls; small.en is sharper but ~2x slower
curl -L -o ~/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

**2. Answers** — install [Ollama](https://ollama.com/download), then:

```bash
ollama pull llama3.1:8b       # answers
ollama pull nomic-embed-text  # semantic search over your materials
```

**3. The app**

```bash
git clone https://github.com/riyagoelrs/cluely.git
cd cluely
npm install
cp .env.example .env          # set WHISPER_MODEL to the path from step 1
npm start
```

`npm test` runs the logic tests — no Whisper, Ollama, or GPU required.

### Model choices

| | Faster | Default | Sharper |
|---|---|---|---|
| Whisper | `ggml-tiny.en.bin` | **`ggml-base.en.bin`** | `ggml-small.en.bin` |
| Ollama | `llama3.2:3b` | **`llama3.1:8b`** | `qwen2.5:14b` |

If answers land after the moment has passed, drop a tier before you change anything
else. On a live call, speed *is* quality.

## Your materials

Drop `.md` and `.txt` files into `materials/` — interview prep, product docs, past
call transcripts, spec notes, whatever you want the copilot to know. Click **Docs** in
the title bar to open the folder, and the **DOCS** chip to re-index after editing.

Only the passages that match the question are sent to the model, so the folder can be
far larger than any prompt. Retrieval is keyword-first and always works; when the
embedding model is available results are also ranked semantically, so a question
phrased differently from your notes still finds them.

`context.md` is the other half: a single page of always-included facts (who you are,
what this call is, the numbers you blank on). Both are re-read on every answer, so you
can edit either one mid-call.

Nothing here is uploaded. With the default providers, your materials are read from
disk, matched locally, and handed to a model running on your own machine.

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

Title bar: **Auto** toggles automatic answering, **Ghost** makes the overlay
click-through (move the pointer over the title bar to get it back), **Notes** opens
`context.md`, **Docs** opens `materials/`.

The overlay sets `setContentProtection(true)`, so it stays out of screen shares and
screenshots. Treat that as a courtesy, not a guarantee: on macOS 15.4+ some modern
capture APIs can see through it, and no window flag has ever stopped a phone camera.

## System audio

Capturing the *other* person means capturing what your machine plays:

- **Windows** — works out of the box via `getDisplayMedia` loopback.
- **macOS** — needs **macOS 14.4+** and Screen Recording permission (System Settings →
  Privacy & Security → Screen Recording). Loopback goes through ScreenCaptureKit,
  which Chromium keeps behind two feature flags; the app enables
  `MacLoopbackAudioForScreenShare` and `MacSckSystemAudioLoopbackOverride` at startup
  so you don't have to. Below 14.4, or if loopback is silent, install
  [BlackHole](https://github.com/ExistentialAudio/BlackHole), route your call app
  through a Multi-Output Device that includes it, and set `SYSTEM_AUDIO_DEVICE=BlackHole`.
- **Linux** — use a PulseAudio/PipeWire monitor source: `SYSTEM_AUDIO_DEVICE=Monitor of`.

If the **THEM** chip never turns green, fix that before anything else — hover it for
the underlying error. Test on a YouTube video before you test on a real call.

Your mic is captured with echo cancellation on, but **use headphones anyway**: it is
more reliable than any AEC at keeping their voice out of your mic stream.

## Configuration

All in `.env`; `.env.example` is the annotated list.

| Variable | Default | Why you'd change it |
|---|---|---|
| `STT_PROVIDER` | `whisper` | `deepgram` for cloud transcription (needs a key) |
| `ANSWER_PROVIDER` | `ollama` | `claude` for cloud answers (needs a key) |
| `WHISPER_MODEL` | — | **Required.** Path to your ggml model file |
| `OLLAMA_MODEL` | `llama3.1:8b` | Trade answer quality against latency |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text` | Blank disables semantic search; keyword search still runs |
| `MATERIALS_TOP_K` | `4` | More passages = better grounding, slower answers |
| `AUTO_ANSWER` | `true` | `false` makes every answer manual |
| `SYSTEM_AUDIO_DEVICE` | *(empty)* | Virtual-cable name, when loopback isn't available |

Both the transcription and answer layers sit behind interfaces (`SttProvider`,
`AnswerProvider`), so the cloud paths are one file each and swapping in another engine
means implementing an interface, not rewriting the app.

## How it's put together

```
src/main/          Electron main — audio routing, transcription, answers
  main.ts            wiring: IPC, hotkeys, the auto-answer decision
  stt/
    whisper.ts       local transcription: whisper.cpp as a subprocess
    vad.ts           energy-gated utterance segmenter + WAV encoding
    deepgram.ts      cloud alternative behind the same interface
  answer/
    ollama.ts        local answers, streamed over NDJSON
    claude.ts        cloud alternative behind the same interface
  materials.ts       indexes materials/, retrieves per question
  transcript.ts      rolling record, one in-flight partial per speaker
  question-detector.ts  local heuristic: "did they just ask me something?"
  answer-engine.ts   prompt construction, cancellation, streaming
  windows.ts         overlay + hidden capture window, loopback media handler
src/renderer/
  capture.ts         the audio graph (getUserMedia + getDisplayMedia -> 16 kHz PCM)
  overlay.*          the floating UI
src/preload/       the only bridge between the two; context isolation stays on
```

Audio never touches disk except as a short-lived temp WAV per utterance, deleted as
soon as Whisper has read it. Transcripts are held in memory and die with the process.

Two design notes worth knowing:

**Whisper runs as a subprocess, not a native module.** Native addons must be rebuilt
against Electron's ABI on every Electron bump, and a mismatch fails at runtime in the
user's hands. A subprocess is immune to that, and costs a few milliseconds of spawn
time against seconds of inference.

**Whisper transcribes clips, not streams,** so `vad.ts` decides where an utterance
starts and stops — an energy gate with an adaptive noise floor, pre-roll so the first
consonant survives, and a hard cut at 20s so a monologue still produces answers.

## Prior art

This problem has been solved several times over, and the versions worth reading differ
in ways that shaped the choices here:

- **[pickle-com/glass](https://github.com/pickle-com/glass)** — the original open-source
  build of this idea; the reference most later projects fork from.
- **[cue](https://github.com/Blueturboguy07/cue)** — macOS-focused, and the source of the
  ScreenCaptureKit flag detail above. Also the most honest about where invisibility stops
  working.
- **[Natively](https://github.com/Natively-AI-assistant/natively-cluely-ai-assistant)** —
  the maximal version: a Rust native module for capture, local models, local RAG, and a
  long list of BYOK providers. No Linux support.
- **[Open-Cluely](https://github.com/shubhamshnd/Open-Cluely)** — Electron + AssemblyAI +
  Gemini, Windows-first. Every answer is a button press.
- **[free-cluely](https://github.com/Prat011/free-cluely)** — Gemini or Ollama, and the
  screenshot-analysis approach this one currently lacks.

Where this one differs: answers fire automatically off a local question heuristic
rather than a hotkey, speaker attribution comes from two independent transcription
sessions rather than diarization, and the default configuration has no cloud in it.

**Not built yet:** screen capture. Several of the projects above screenshot the screen
and feed it to the model, which matters when the question is a coding problem *on
screen* rather than something spoken. That's the most valuable thing to add next.

## Before you use this on a real call

Running locally removes the third parties, but not the law. Recording a conversation
you are part of is legal in much of the world and illegal without the other side's
consent in plenty of it — all-party-consent jurisdictions include California, Florida,
Illinois, Pennsylvania, and much of the EU. That applies to a recording made entirely
on your own laptop. Say something at the top of the call; "I've got an AI assistant
taking notes" costs three seconds and solves the whole problem.

Some contexts have their own rules regardless of the law — proctored exams and many
technical interviews prohibit assistance outright. Being undetectable is not the same
as being permitted.
