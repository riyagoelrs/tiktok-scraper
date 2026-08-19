/**
 * Cheap, local test for "did the other side just ask me something?".
 *
 * This runs on every finalized utterance from the far side, so it has to be
 * instant and free — no model call. It errs toward answering: a spurious answer
 * card costs a glance, a missed one costs the moment.
 */

const INTERROGATIVE = /^(what|why|how|when|where|who|whom|whose|which|is|are|was|were|do|does|did|can|could|would|will|should|shall|have|has|had|may|might|am)\b/i;

const PROMPTS = [
  'tell me about',
  'tell me a',
  'walk me through',
  'talk me through',
  'talk to me about',
  'give me an example',
  'give me a sense',
  'describe',
  'explain',
  "i'd love to hear",
  'id love to hear',
  'i would love to hear',
  'curious about',
  'curious how',
  'curious what',
  "let's talk about",
  'lets talk about',
  'help me understand',
  'any thoughts on',
  'thoughts on',
  'what about',
  'how about',
  'your take on',
  'go into detail',
  'elaborate',
];

/** Utterances that end in '?' but are not really requests for information. */
const PLEASANTRIES = /^(hi|hey|hello|thanks|thank you|ok|okay|got it|sure|right|cool|yeah|yes|no|sorry|great|awesome|perfect|mhm|uh huh)\b[\s,.!?]*$/i;

const SMALL_TALK = [
  'how are you',
  'how are you doing',
  "how's it going",
  'hows it going',
  'can you hear me',
  'can you see my screen',
  'do you hear me',
  'are you there',
  'is that better',
  'does that make sense',
  'make sense',
  'sound good',
  'any questions',
  'is now still a good time',
];

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function looksLikeQuestion(text: string): boolean {
  const normalized = normalize(text);
  if (!normalized) return false;

  const words = normalized.split(' ');
  if (words.length < 3) return false;
  if (PLEASANTRIES.test(normalized)) return false;

  const stripped = normalized.replace(/[?.!,]+$/g, '');
  if (SMALL_TALK.some((phrase) => stripped === phrase || stripped.endsWith(phrase))) return false;

  if (normalized.includes('?')) return true;
  if (PROMPTS.some((prompt) => normalized.includes(prompt))) return true;

  // Deepgram punctuates well, but a dropped '?' shouldn't cost an answer:
  // treat a leading interrogative on a short utterance as a question anyway.
  if (INTERROGATIVE.test(normalized) && words.length <= 25) return true;

  return false;
}

/** Key used to avoid answering the same question twice in a row. */
export function questionKey(text: string): string {
  return normalize(text).replace(/[^a-z0-9 ]/g, '');
}
