/**
 * Turning a painting into a reel script.
 *
 * One API call: the downscaled painting plus its catalogue facts go up, a
 * structured script comes back. Every beat carries the text to burn in and the
 * region of the canvas the camera should be looking at while it is on screen.
 */

import { generateJson } from './anthropic.js';

const RECT = {
  type: 'object',
  description: 'A region of the painting in fractions of its width and height, origin top-left.',
  properties: {
    x: { type: 'number', minimum: 0, maximum: 1 },
    y: { type: 'number', minimum: 0, maximum: 1 },
    w: { type: 'number', minimum: 0.05, maximum: 1 },
    h: { type: 'number', minimum: 0.05, maximum: 1 },
  },
  required: ['x', 'y', 'w', 'h'],
  additionalProperties: false,
};

const BEAT = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      description: 'The caption burned onto the screen for this beat. 8-28 words.',
    },
    focus: RECT,
    motion: {
      type: 'string',
      enum: ['in', 'out', 'left', 'right', 'up', 'down', 'hold'],
      description: 'How the camera moves across this beat.',
    },
    captionPos: { type: 'string', enum: ['top', 'center', 'lower'] },
    seconds: { type: 'number', minimum: 3, maximum: 14 },
  },
  required: ['text', 'focus', 'motion', 'captionPos', 'seconds'],
  additionalProperties: false,
};

const SCHEMA = {
  type: 'object',
  properties: {
    reelTitle: {
      type: 'string',
      description: 'A short internal label for this reel. Not shown on screen.',
    },
    hook: BEAT,
    beats: { type: 'array', items: BEAT, minItems: 4, maxItems: 18 },
    payoff: BEAT,
    grounding: {
      type: 'string',
      description:
        'One or two sentences: which claims come from the supplied catalogue facts, ' +
        'which are plain description of what is visible, and anything you were unsure of.',
    },
  },
  required: ['reelTitle', 'hook', 'beats', 'payoff', 'grounding'],
  additionalProperties: false,
};

const VOICES = {
  plain: `Plain, quiet, declarative. Short sentences. No exclamation marks, no rhetorical questions,
no "let that sink in". You are pointing at things and saying what they are. Present tense.`,
  detective: `A detective walking the scene. Each beat is a piece of evidence that narrows the reading.
Name the clue, then say what it means. Present tense, dry, unhurried.`,
  witness: `An eyewitness standing in the painting, describing it as it happens around you.
Present tense, sensory, close in. Never break out to talk about the artist mid-story.`,
  essay: `A short reflective essay read aloud. Slightly longer sentences, one idea per beat,
building to a thought that reframes the first line.`,
};

const SYSTEM = `You write scripts for short vertical videos about a single painting.

THE FORMAT
The video shows one painting. The camera starts wide, then cuts between close crops
of details, slowly pushing in or drifting across each one. A line of text sits over
the image for the whole of each shot. There is no voice-over and no music you can
rely on: the text carries everything.

WHAT MAKES ONE GOOD
- The first line is the whole game. It must make someone stop scrolling without
  promising anything the painting cannot deliver. Never open with the title, the
  artist, the date, or "This painting". Open on a detail, a contradiction, or the
  human situation. It should read like the middle of a sentence someone is already
  telling you.
- Then one detail per beat, in an order that builds. Each beat should show the
  viewer something they would not have found on their own, and each should change
  what the previous beat meant.
- Withhold the title and artist until the very end. That is what the closing card
  is for.
- The payoff must land. Prefer a documented fact that recontextualises the whole
  picture over a poetic flourish.

TRUTH
Everything you assert must be either (a) plainly visible in the image, or
(b) supported by the catalogue facts you are given. If a reading is a scholarly
interpretation rather than a fact, phrase it as one: "art historians read this as",
"the usual reading is", "no one has settled". Never invent a date, a name, a quotation,
a museum, a price, a diagnosis, or a biographical incident. If you are not sure a
detail is really in the image, do not write a beat about it. An honest, plain script
beats an exciting invented one; this account's whole value is that it is right.

THE CAMERA
For each beat, give the region of the painting the camera should be on, in fractions
of the painting's width and height, origin at the top-left corner.
- Crop tight enough that the detail actually fills the screen. For a single face,
  hand or object, that is usually 0.12 to 0.30 of the painting's width. Only the
  hook and the payoff should be wide.
- The region must contain the thing you are talking about, with a little air around it.
- The screen is 9:16, tall. A tall region fills it; a wide region will sit in the
  middle of the frame with black above and below, which is fine and normal.
- "in" pushes closer, "out" pulls back, "left"/"right"/"up"/"down" drift that way,
  "hold" is nearly still. Vary them; do not push in on every beat.
- Put the caption where it will not cover the thing you are pointing at: "top",
  "center" or "lower".

THE TEXT ITSELF
- 8 to 28 words per beat, broken into 2-4 short lines' worth of thought.
- No emoji, no hashtags, no "swipe", no "follow for more", no numbering.
- Never name the painting or artist before the payoff beat.
- Plain modern English. Do not use words like "mesmerising", "haunting", "iconic",
  "masterpiece", or "hidden meaning".`;

/**
 * @returns {{script: object, usage: object}}
 */
export async function writeScript({
  apiKey,
  model,
  effort,
  painting,
  imageBase64,
  mediaType,
  voice,
  beatCount,
  seconds,
  strictFacts,
  signal,
}) {
  const facts = painting.notes
    ? `Catalogue facts (treat as reliable; you may use any of them):\n${painting.notes}`
    : 'No catalogue facts are available for this image. Describe only what you can see, and do not name the work or the artist.';

  const known = painting.notes
    ? `Title: ${painting.title}\nArtist: ${painting.artist}\nDate: ${painting.year}\nCollection: ${painting.museum}`
    : 'Title, artist and date: unknown.';

  const strictLine = strictFacts
    ? 'Strict mode is on: if a beat cannot be justified from the image or the catalogue facts, cut it and write a shorter script.'
    : 'You may include widely-repeated interpretations, but mark them as readings rather than facts.';

  const prompt = `${known}

${facts}

Write the script for this painting.

Voice: ${VOICES[voice] || VOICES.plain}

Length: a hook, then ${beatCount} beats, then a payoff. Aim for about ${seconds} seconds
per beat; give shorter beats less text and longer beats more, and set "seconds" per beat
so the text is comfortably readable at roughly 2.5 words per second with a moment to spare.

${strictLine}

Look at the image carefully before you write. Find the details a casual viewer misses -
what is in the corners, what people are doing with their hands, what is on the floor,
what is happening behind the main figures - and build the order of the beats out of those.`;

  const { data, usage } = await generateJson({
    apiKey,
    model,
    effort,
    signal,
    maxTokens: 16000,
    system: SYSTEM,
    content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
      { type: 'text', text: prompt },
    ],
    schema: SCHEMA,
  });

  return { script: normalise(data, seconds), usage };
}

/** Clamps whatever came back into something the renderer can always draw. */
function normalise(raw, defaultSeconds) {
  const beat = (b, fallbackPos) => {
    const focus = b?.focus || {};
    let w = clamp(num(focus.w, 0.5), 0.06, 1);
    let h = clamp(num(focus.h, 0.5), 0.06, 1);
    let x = clamp(num(focus.x, (1 - w) / 2), 0, 1);
    let y = clamp(num(focus.y, (1 - h) / 2), 0, 1);
    if (x + w > 1) x = Math.max(0, 1 - w);
    if (y + h > 1) y = Math.max(0, 1 - h);
    return {
      text: String(b?.text || '').trim(),
      focus: { x, y, w, h },
      motion: ['in', 'out', 'left', 'right', 'up', 'down', 'hold'].includes(b?.motion)
        ? b.motion
        : 'in',
      captionPos: ['top', 'center', 'lower'].includes(b?.captionPos)
        ? b.captionPos
        : fallbackPos,
      seconds: clamp(num(b?.seconds, defaultSeconds), 2.5, 15),
    };
  };

  const beats = Array.isArray(raw?.beats) ? raw.beats.map((b) => beat(b, 'center')) : [];

  return {
    reelTitle: String(raw?.reelTitle || '').trim(),
    grounding: String(raw?.grounding || '').trim(),
    beats: [
      { ...beat(raw?.hook, 'center'), role: 'hook' },
      ...beats.filter((b) => b.text).map((b) => ({ ...b, role: 'beat' })),
      { ...beat(raw?.payoff, 'lower'), role: 'payoff' },
    ].filter((b) => b.text),
  };
}

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Rough token counts for the sidebar estimate.
 *
 * Thinking is on by default on Opus 5 and Sonnet 5 and is billed as output, so
 * it has to be in the estimate or the number reads about half what you pay. The
 * allowance is a guess; the script panel shows the real usage after each call.
 */
const THINKING_ALLOWANCE = { low: 500, medium: 1400, high: 2800 };

export function estimateTokens(beatCount, model = 'claude-opus-5', effort = 'high') {
  const thinks = model !== 'claude-haiku-4-5';
  return {
    input: 2200,
    output: 220 + beatCount * 95 + (thinks ? THINKING_ALLOWANCE[effort] ?? 2800 : 0),
  };
}
