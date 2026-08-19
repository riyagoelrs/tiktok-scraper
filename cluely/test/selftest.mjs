// Runs the pure logic of the copilot without Electron: `npm test`.
// The Electron-facing modules (windows, main) are excluded by design — they need
// a display — but everything that decides *what* gets answered is covered here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocketServer } from 'ws';

const { looksLikeQuestion, questionKey } = await import('../dist/main/question-detector.js');
const { Transcript } = await import('../dist/main/transcript.js');
const { DeepgramProvider } = await import('../dist/main/stt/deepgram.js');

test('question detector catches real questions', () => {
  for (const asked of [
    'What is your experience with distributed systems?',
    'how would you scale this to a million users',
    'Can you walk me through the architecture?',
    'Tell me about a time you disagreed with your manager.',
    "I'm curious what your pricing looks like",
    'So why did you leave your last role?',
  ]) {
    assert.equal(looksLikeQuestion(asked), true, asked);
  }
});

test('question detector ignores conversational noise', () => {
  for (const chatter of [
    'Yeah?',
    'Okay.',
    'How are you doing?',
    'Can you hear me?',
    'Does that make sense?',
    'Right, so we shipped it last quarter.',
    'sounds good',
  ]) {
    assert.equal(looksLikeQuestion(chatter), false, chatter);
  }
});

test('question keys ignore punctuation and case', () => {
  assert.equal(questionKey('What is your stack?'), questionKey('what is your STACK'));
});

test('transcript revises a partial then commits it as one line', () => {
  const seen = [];
  const transcript = new Transcript((line) => seen.push({ ...line }));

  transcript.partial('them', 'what is');
  transcript.partial('them', 'what is your');
  const committed = transcript.commit('them', 'What is your stack?');

  // Same id throughout, so the overlay updates one row instead of stacking three.
  assert.equal(seen.length, 3);
  assert.equal(new Set(seen.map((l) => l.id)).size, 1);
  assert.equal(committed.final, true);
  assert.equal(transcript.lastFrom('them').text, 'What is your stack?');
  assert.equal(transcript.lastFrom('me'), undefined);
});

test('transcript renders a labelled window for the model', () => {
  const transcript = new Transcript(() => {});
  transcript.commit('me', 'Hi there.');
  transcript.commit('them', 'What is your stack?');
  assert.equal(transcript.render(10), 'ME: Hi there.\nTHEM: What is your stack?');
  assert.equal(transcript.render(1), 'THEM: What is your stack?');
});

test('deepgram session stitches final segments into one utterance', async () => {
  const server = new WebSocketServer({ port: 0 });
  const port = server.address().port;

  /** @type {Buffer[]} */
  const received = [];
  let authHeader;

  const connected = new Promise((resolve) => {
    server.on('connection', (socket, request) => {
      authHeader = request.headers.authorization;
      socket.on('message', (data, isBinary) => {
        if (isBinary) received.push(Buffer.from(data));
      });
      resolve(socket);
    });
  });

  const provider = new DeepgramProvider({
    deepgramApiKey: 'test-key',
    deepgramModel: 'nova-3',
    deepgramEndpoint: `ws://127.0.0.1:${port}`,
    language: 'en',
  });

  const partials = [];
  const finals = [];
  const states = [];
  const session = provider.open('test', {
    onPartial: (t) => partials.push(t),
    onFinal: (t) => finals.push(t),
    onState: (s) => states.push(s),
  });

  const socket = await connected;
  await new Promise((resolve) => setTimeout(resolve, 50));

  session.send(Buffer.from(new Int16Array([1, 2, 3]).buffer));

  const say = (payload) => socket.send(JSON.stringify(payload));
  const results = (transcript, flags) => ({
    type: 'Results',
    channel: { alternatives: [{ transcript }] },
    ...flags,
  });

  say(results('what is', { is_final: false }));
  say(results('What is your', { is_final: true }));
  say(results('stack these days?', { is_final: true, speech_final: true }));

  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(authHeader, 'Token test-key');
  assert.deepEqual(finals, ['What is your stack these days?']);
  assert.ok(partials.includes('what is'));
  assert.ok(states.includes('up'));
  assert.equal(received.length, 1);
  assert.equal(received[0].length, 6);

  session.close();
  server.close();
});

test('deepgram session flushes on UtteranceEnd when speech_final never arrives', async () => {
  const server = new WebSocketServer({ port: 0 });
  const port = server.address().port;

  const connected = new Promise((resolve) => server.on('connection', resolve));

  const provider = new DeepgramProvider({
    deepgramApiKey: 'k',
    deepgramModel: 'nova-3',
    deepgramEndpoint: `ws://127.0.0.1:${port}`,
    language: 'en',
  });

  const finals = [];
  const session = provider.open('test', {
    onPartial: () => {},
    onFinal: (t) => finals.push(t),
    onState: () => {},
  });

  const socket = await connected;
  socket.send(
    JSON.stringify({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'Hello there' }] } }),
  );
  socket.send(JSON.stringify({ type: 'UtteranceEnd' }));

  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(finals, ['Hello there']);

  session.close();
  server.close();
});
