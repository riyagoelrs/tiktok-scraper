import type { CaptureState, Speaker } from '../shared/types';

interface CaptureStartOptions {
  systemAudioDevice: string;
}

interface CaptureApi {
  onStart(cb: (options: CaptureStartOptions) => void): void;
  onStop(cb: () => void): void;
  sendChunk(source: Speaker, pcm: ArrayBuffer): void;
  reportState(state: CaptureState): void;
}

declare global {
  interface Window {
    capture: CaptureApi;
  }
}

const TARGET_RATE = 16_000;

interface Graph {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  worklet: AudioWorkletNode;
  sink: GainNode;
}

let audioContext: AudioContext | undefined;
let workletReady: Promise<void> | undefined;
const graphs = new Map<Speaker, Graph>();

function report(source: Speaker, capturing: boolean, error?: string): void {
  window.capture.reportState({ source, capturing, error });
}

async function getContext(): Promise<AudioContext> {
  if (!audioContext || audioContext.state === 'closed') {
    // Asking for 16 kHz up front lets the browser do the resampling for us; if it
    // refuses, downsample() below covers the difference.
    audioContext = new AudioContext({ sampleRate: TARGET_RATE, latencyHint: 'interactive' });
    workletReady = audioContext.audioWorklet.addModule('./pcm-worklet.js');
  }
  await workletReady;
  if (audioContext.state === 'suspended') await audioContext.resume();
  return audioContext;
}

/** Linear resample; only runs when the browser wouldn't give us a 16 kHz context. */
function downsample(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === TARGET_RATE) return input;
  const ratio = fromRate / TARGET_RATE;
  const length = Math.floor(input.length / ratio);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const frac = position - index;
    const a = input[index] ?? 0;
    const b = input[index + 1] ?? a;
    output[i] = a + (b - a) * frac;
  }
  return output;
}

function toPcm16(samples: Float32Array): ArrayBuffer {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return pcm.buffer;
}

async function attach(source: Speaker, stream: MediaStream): Promise<void> {
  const ctx = await getContext();
  const node = ctx.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(ctx, 'pcm-collector', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: 'explicit',
  });

  worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
    window.capture.sendChunk(source, toPcm16(downsample(event.data, ctx.sampleRate)));
  };

  // A worklet only runs while it is part of a live graph, so terminate it in a
  // muted gain node rather than leaving it dangling (which would also echo).
  const sink = ctx.createGain();
  sink.gain.value = 0;
  node.connect(worklet);
  worklet.connect(sink);
  sink.connect(ctx.destination);

  graphs.set(source, { stream, source: node, worklet, sink });

  for (const track of stream.getAudioTracks()) {
    track.addEventListener('ended', () => {
      detach(source);
      report(source, false, 'audio track ended');
    });
  }

  report(source, true);
}

function detach(source: Speaker): void {
  const graph = graphs.get(source);
  if (!graph) return;
  graphs.delete(source);
  graph.worklet.port.onmessage = null;
  graph.source.disconnect();
  graph.worklet.disconnect();
  graph.sink.disconnect();
  for (const track of graph.stream.getTracks()) track.stop();
}

async function startMic(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      // Without echo cancellation the mic re-records the other person coming out
      // of the speakers, and both transcripts say the same thing.
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  await attach('me', stream);
}

async function startSystem(deviceLabel: string): Promise<void> {
  let stream: MediaStream;

  if (deviceLabel) {
    // Explicit virtual-cable route (BlackHole, VB-Cable, a PulseAudio monitor).
    const devices = await navigator.mediaDevices.enumerateDevices();
    const match = devices.find(
      (d) => d.kind === 'audioinput' && d.label.toLowerCase().includes(deviceLabel.toLowerCase()),
    );
    if (!match) throw new Error(`No audio input matching "${deviceLabel}"`);
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: match.deviceId },
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  } else {
    // Loopback: main's display-media handler answers this with the screen plus
    // whatever the machine is playing.
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    for (const track of stream.getVideoTracks()) {
      track.stop();
      stream.removeTrack(track);
    }
  }

  if (stream.getAudioTracks().length === 0) {
    for (const track of stream.getTracks()) track.stop();
    throw new Error('No system audio track — see the system audio notes in the README');
  }

  await attach('them', stream);
}

window.capture.onStart(async (options) => {
  await Promise.allSettled([
    startMic().catch((err: unknown) => report('me', false, message(err))),
    startSystem(options.systemAudioDevice).catch((err: unknown) =>
      report('them', false, message(err)),
    ),
  ]);
});

window.capture.onStop(() => {
  detach('me');
  detach('them');
  report('me', false);
  report('them', false);
});

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
