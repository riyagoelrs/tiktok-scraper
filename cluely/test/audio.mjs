// Validation against real human speech rather than synthetic tones.
//
// fixtures/speech-16k.wav is an 11s public-domain recording (JFK, 1961) shipped
// with whisper.cpp. Real speech has breaths, trailing consonants and uneven
// amplitude, all of which a naive energy gate gets wrong — a sine wave will
// never catch those mistakes.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { UtteranceSegmenter, encodeWav, DEFAULT_SEGMENTER } = await import('../dist/main/stt/vad.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'speech-16k.wav');
const RATE = 16000;

/** Minimal WAV reader: finds the data chunk rather than assuming offset 44. */
function readWav(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.subarray(0, 4).toString(), 'RIFF');
  let offset = 12;
  let fmt;
  while (offset + 8 <= buf.length) {
    const id = buf.subarray(offset, offset + 4).toString();
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = { channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      const pcm = new Int16Array(size / 2);
      for (let i = 0; i < pcm.length; i += 1) pcm[i] = buf.readInt16LE(body + i * 2);
      return { ...fmt, pcm };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('no data chunk');
}

test('fixture is the 16 kHz mono format the pipeline expects', () => {
  const { channels, rate, bits, pcm } = readWav(FIXTURE);
  assert.equal(channels, 1);
  assert.equal(rate, RATE);
  assert.equal(bits, 16);
  assert.ok(pcm.length / RATE > 10, 'about 11 seconds of audio');
});

test('segmenter finds speech in a real recording and keeps nearly all of it', () => {
  const { pcm } = readWav(FIXTURE);
  const utterances = [];
  const segmenter = new UtteranceSegmenter(
    { sampleRate: RATE, ...DEFAULT_SEGMENTER },
    (u) => utterances.push(u),
  );

  // Feed it the way capture does: 2048-sample frames, in order.
  for (let i = 0; i < pcm.length; i += 2048) segmenter.push(pcm.subarray(i, i + 2048));
  segmenter.flush();

  assert.ok(utterances.length >= 1, 'found speech');
  assert.ok(utterances.length <= 4, `did not shred the clip into fragments (got ${utterances.length})`);

  const captured = utterances.reduce((sum, u) => sum + u.length, 0);
  const ratio = captured / pcm.length;
  // The gate should drop leading/trailing silence but keep the words. Losing a
  // third of a sentence means the transcript loses the question.
  assert.ok(ratio > 0.7, `kept ${(ratio * 100).toFixed(0)}% of the audio, expected >70%`);
  assert.ok(ratio <= 1.0);
});

test('segmenter output round-trips through the WAV encoder', () => {
  const { pcm } = readWav(FIXTURE);
  const utterances = [];
  const segmenter = new UtteranceSegmenter(
    { sampleRate: RATE, ...DEFAULT_SEGMENTER },
    (u) => utterances.push(u),
  );
  for (let i = 0; i < pcm.length; i += 2048) segmenter.push(pcm.subarray(i, i + 2048));
  segmenter.flush();

  const tmp = path.join(here, 'fixtures', '.roundtrip.wav');
  fs.writeFileSync(tmp, encodeWav(utterances[0], RATE));
  try {
    // Parsed by the same reader that handled a file whisper.cpp itself ships.
    const decoded = readWav(tmp);
    assert.equal(decoded.rate, RATE);
    assert.equal(decoded.channels, 1);
    assert.equal(decoded.bits, 16);
    assert.equal(decoded.pcm.length, utterances[0].length, 'no samples lost');
    assert.equal(decoded.pcm[1000], utterances[0][1000], 'samples survive intact');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('a silent recording produces no utterances at all', () => {
  const utterances = [];
  const segmenter = new UtteranceSegmenter(
    { sampleRate: RATE, ...DEFAULT_SEGMENTER },
    (u) => utterances.push(u),
  );
  // Quiet room tone, not digital silence — this is what a real mic sends.
  const room = new Int16Array(RATE * 5);
  for (let i = 0; i < room.length; i += 1) room[i] = Math.round((Math.random() - 0.5) * 60);
  for (let i = 0; i < room.length; i += 2048) segmenter.push(room.subarray(i, i + 2048));
  segmenter.flush();

  assert.equal(utterances.length, 0, 'room tone must not trigger the gate');
});
