// Tests for the fully-local stack: VAD segmentation, whisper.cpp subprocess
// handling, Ollama streaming, and materials retrieval. Nothing here needs
// whisper, Ollama, or a GPU — the external pieces are stubbed at their real
// boundaries (a fake CLI binary, a real HTTP server speaking Ollama's protocol).
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const { UtteranceSegmenter, encodeWav, DEFAULT_SEGMENTER } = await import('../dist/main/stt/vad.js');
const { WhisperProvider, clean } = await import('../dist/main/stt/whisper.js');
const { OllamaProvider, readNdjson } = await import('../dist/main/answer/ollama.js');
const { Materials, chunkText, tokenize, cosine } = await import('../dist/main/materials.js');

const RATE = 16000;

/** Tone loud enough to read as speech. */
function speech(ms, amplitude = 8000) {
  const samples = new Int16Array(Math.round((RATE * ms) / 1000));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / RATE) * amplitude);
  }
  return samples;
}

function silence(ms) {
  return new Int16Array(Math.round((RATE * ms) / 1000));
}

function feed(segmenter, ...parts) {
  for (const part of parts) segmenter.push(part);
}

test('segmenter emits one utterance per speech burst', () => {
  const utterances = [];
  const segmenter = new UtteranceSegmenter(
    { sampleRate: RATE, ...DEFAULT_SEGMENTER },
    (pcm) => utterances.push(pcm),
  );

  feed(segmenter, silence(300), speech(1200), silence(900), speech(800), silence(900));

  assert.equal(utterances.length, 2);
  // Each utterance carries its pre-roll, so it is at least as long as the speech.
  assert.ok(utterances[0].length >= RATE * 1.2, 'first utterance keeps its audio');
});

test('segmenter ignores silence and blips too short to be speech', () => {
  const utterances = [];
  const segmenter = new UtteranceSegmenter(
    { sampleRate: RATE, ...DEFAULT_SEGMENTER },
    (pcm) => utterances.push(pcm),
  );

  feed(segmenter, silence(2000), speech(80), silence(1000));
  assert.equal(utterances.length, 0);
});

test('segmenter cuts a monologue at the max length instead of waiting forever', () => {
  const utterances = [];
  const segmenter = new UtteranceSegmenter(
    { sampleRate: RATE, ...DEFAULT_SEGMENTER, maxSegmentMs: 2000 },
    (pcm) => utterances.push(pcm),
  );

  feed(segmenter, speech(5000));
  assert.ok(utterances.length >= 2, 'long speech produced multiple segments');
});

test('wav encoding produces a valid 16 kHz mono header', () => {
  const wav = encodeWav(speech(100), RATE);
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 1, 'mono');
  assert.equal(wav.readUInt32LE(24), RATE);
  assert.equal(wav.readUInt16LE(34), 16, '16-bit');
  assert.equal(wav.readUInt32LE(4), wav.length - 8, 'RIFF size matches payload');
});

test('whisper output cleaning drops non-speech markers and hallucinated filler', () => {
  assert.equal(clean('  Hello there.  \n'), 'Hello there.');
  assert.equal(clean('[BLANK_AUDIO]'), '');
  assert.equal(clean('(silence)'), '');
  assert.equal(clean('Thank you.'), '');
  assert.equal(clean('What is your stack?\n[BLANK_AUDIO]'), 'What is your stack?');
});

test('whisper provider runs the binary and reports the transcript', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluely-whisper-'));
  const model = path.join(dir, 'ggml-test.bin');
  fs.writeFileSync(model, 'not-a-real-model');

  // Stand-in for whisper-cli: asserts it was handed a real WAV, then answers.
  const binary = path.join(dir, 'fake-whisper.sh');
  fs.writeFileSync(
    binary,
    ['#!/bin/sh', 'while [ "$1" != "-f" ]; do shift; done', 'head -c 4 "$2"', 'echo " Ship it."'].join('\n'),
  );
  fs.chmodSync(binary, 0o755);

  const provider = new WhisperProvider({
    whisperBinary: binary,
    whisperModel: model,
    whisperThreads: 1,
    language: 'en',
  });

  const finals = [];
  const states = [];
  const session = provider.open('mic', {
    onPartial: () => {},
    onFinal: (t) => finals.push(t),
    onState: (s, e) => states.push([s, e]),
  });

  const pcm = speech(900);
  session.send(Buffer.from(pcm.buffer));
  session.send(Buffer.from(silence(900).buffer));

  await new Promise((resolve) => setTimeout(resolve, 600));

  assert.equal(finals.length, 1, `expected one transcript, got ${JSON.stringify(finals)}`);
  // Proves the subprocess received a real WAV file, not raw PCM.
  assert.match(finals[0], /^RIFF Ship it\.$/);
  assert.ok(states.some(([s]) => s === 'up'));

  session.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('whisper provider refuses to start without a model file', () => {
  const provider = new WhisperProvider({ whisperBinary: 'whisper-cli', whisperModel: '', whisperThreads: 1, language: 'en' });
  assert.throws(() => provider.open('mic', {}), /WHISPER_MODEL is not set/);
});

test('ndjson reader reassembles lines split across chunks', async () => {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode('{"a":1}\n{"b'));
      controller.enqueue(encoder.encode('":2}\n{"c":3}'));
      controller.close();
    },
  });
  const lines = [];
  await readNdjson(stream, (line) => lines.push(line));
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test('ollama provider streams tokens from a live server', async () => {
  let received;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      received = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { content: 'Ship ' } }) + '\n');
      res.write(JSON.stringify({ message: { content: 'it.' } }) + '\n');
      res.end(JSON.stringify({ done: true }) + '\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  const provider = new OllamaProvider({ ollamaUrl: url, ollamaModel: 'llama3.1:8b' });
  let text = '';
  await provider.generate({
    system: 'be brief',
    user: 'what now?',
    maxTokens: 100,
    signal: new AbortController().signal,
    onDelta: (d) => { text += d; },
  });

  assert.equal(text, 'Ship it.');
  assert.equal(received.model, 'llama3.1:8b');
  assert.equal(received.stream, true);
  assert.equal(received.messages[0].role, 'system');
  assert.equal(received.messages[1].content, 'what now?');
  server.close();
});

test('ollama provider sends a screenshot to the vision model, not the text model', async () => {
  let received;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      received = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(JSON.stringify({ message: { content: 'Off by one on line 12.' }, done: true }) + '\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  const provider = new OllamaProvider({ ollamaUrl: url, ollamaModel: 'llama3.1:8b', ollamaVisionModel: 'llava:7b' });
  let text = '';
  await provider.generate({
    system: 'be brief',
    user: 'what is wrong with this?',
    image: 'iVBORw0KGgo=',
    maxTokens: 100,
    signal: new AbortController().signal,
    onDelta: (d) => { text += d; },
  });

  assert.equal(received.model, 'llava:7b', 'swapped to the multimodal model');
  assert.deepEqual(received.messages[1].images, ['iVBORw0KGgo=']);
  assert.equal(text, 'Off by one on line 12.');
  server.close();
});

test('ollama provider leaves images off when there is no screenshot', async () => {
  let received;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      received = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  const provider = new OllamaProvider({ ollamaUrl: url, ollamaModel: 'llama3.1:8b', ollamaVisionModel: 'llava:7b' });
  await provider.generate({
    system: '', user: 'hi', maxTokens: 10,
    signal: new AbortController().signal, onDelta: () => {},
  });

  assert.equal(received.model, 'llama3.1:8b', 'stayed on the fast text model');
  assert.equal(received.messages[1].images, undefined, 'no empty images array');
  server.close();
});

test('ollama provider explains a missing model instead of leaking a 404', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('model not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  const provider = new OllamaProvider({ ollamaUrl: url, ollamaModel: 'mistral' });
  await assert.rejects(
    provider.generate({
      system: '', user: '', maxTokens: 10,
      signal: new AbortController().signal, onDelta: () => {},
    }),
    /ollama pull mistral/,
  );
  server.close();
});

test('ollama provider says how to start the daemon when it is down', async () => {
  // Port 1 is reserved and never listening.
  const provider = new OllamaProvider({ ollamaUrl: 'http://127.0.0.1:1', ollamaModel: 'x' });
  await assert.rejects(
    provider.generate({
      system: '', user: '', maxTokens: 10,
      signal: new AbortController().signal, onDelta: () => {},
    }),
    /ollama serve/,
  );
});

test('chunking splits on paragraphs and keeps chunks prompt-sized', () => {
  const doc = ['# Title', 'Short intro paragraph.', 'x'.repeat(2000), 'Final note.'].join('\n\n');
  const chunks = chunkText(doc);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) assert.ok(chunk.length <= 1000, `chunk too big: ${chunk.length}`);
  assert.ok(chunks.join(' ').includes('Final note.'));
});

test('tokenize drops stop words and punctuation', () => {
  assert.deepEqual(tokenize('What is the Postgres replication lag?'), ['postgres', 'replication', 'lag']);
});

test('cosine similarity behaves at the extremes', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([0, 0], [1, 1]), 0);
});

test('materials retrieval finds the passage that answers the question', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluely-materials-'));
  fs.writeFileSync(
    path.join(dir, 'migration.md'),
    '# Migration\n\nWe moved 40 million rows with twelve minutes of downtime.\n\nThe rollback plan was a logical replication slot held open for a week.',
  );
  fs.writeFileSync(
    path.join(dir, 'team.md'),
    '# Team\n\nThe team was six engineers. I owned the ingestion side of the pipeline.',
  );
  fs.mkdirSync(path.join(dir, 'nested'));
  fs.writeFileSync(path.join(dir, 'nested', 'perf.md'), '# Perf\n\np99 latency dropped from 1.8 seconds to 240 milliseconds after the read replica split.');
  fs.writeFileSync(path.join(dir, 'ignored.pdf'), 'binary junk');

  const materials = new Materials({
    materialsDir: dir,
    materialsTopK: 2,
    ollamaUrl: 'http://127.0.0.1:1',
    ollamaEmbedModel: '', // embeddings off: exercise the keyword path
  });

  await materials.load();
  const stats = materials.stats();
  assert.equal(stats.files, 3, 'walked nested dirs and skipped non-text files');
  assert.ok(stats.chunks >= 3);

  const hits = await materials.retrieve('how long was the downtime for the migration?', 2);
  assert.ok(hits.length > 0);
  assert.match(hits[0].text, /twelve minutes/);
  assert.equal(hits[0].file, 'migration.md');

  const perf = await materials.retrieve('what happened to p99 latency?', 1);
  assert.match(perf[0].text, /240 milliseconds/);
  assert.equal(perf[0].file, path.join('nested', 'perf.md'));

  const prompt = await materials.prompt('downtime during the migration');
  assert.match(prompt, /\[migration\.md\]/);

  assert.deepEqual(await materials.retrieve('zzzz nonexistent topic', 2), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('materials degrade to an empty prompt when the folder is missing', async () => {
  const materials = new Materials({
    materialsDir: '/nonexistent/path/xyz',
    materialsTopK: 4,
    ollamaUrl: 'http://127.0.0.1:1',
    ollamaEmbedModel: '',
  });
  await materials.load();
  assert.equal(materials.stats().files, 0);
  assert.equal(await materials.prompt('anything'), '');
});
