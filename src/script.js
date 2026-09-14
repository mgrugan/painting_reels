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
      description:
        'The caption burned onto the screen for this beat. 8-28 words, ' +
        'or 6-18 for the hook.',
    },
    subject: {
      type: 'string',
      description:
        'The one thing that must be inside the crop for this beat to work, named ' +
        'plainly: "the glove on the carpet", "the sheet music on the piano stand". ' +
        'Write this before choosing the coordinates.',
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
  required: ['text', 'subject', 'focus', 'motion', 'captionPos', 'seconds'],
  additionalProperties: false,
};

const SCHEMA = {
  type: 'object',
  properties: {
    reelTitle: {
      type: 'string',
      description: 'A short internal label for this reel. Not shown on screen.',
    },
    mood: {
      type: 'string',
      enum: ['elegy', 'tenderness', 'unease', 'menace', 'wonder', 'melancholy', 'grandeur', 'stillness'],
      description:
        'The feeling the finished reel should leave, used to pick the music. ' +
        'Judge the reel you have written, not the painting in the abstract.',
    },
    caption: {
      type: 'string',
      description:
        'The Instagram caption to post with this reel. Two or three sentences ' +
        'that stand on their own for someone who has not watched it, then the ' +
        'title, artist and year on their own line, then 8-12 hashtags.',
    },
    hook: BEAT,
    beats: { type: 'array', items: BEAT, minItems: 6, maxItems: 16 },
    payoff: BEAT,
    commentPrompt: {
      type: 'string',
      description:
        'The closing line asking for comments, 6-14 words, first person. ' +
        'Shown over the whole painting.',
    },
    grounding: {
      type: 'string',
      description:
        'One or two sentences: which claims come from the supplied catalogue facts, ' +
        'which are plain description of what is visible, and anything you were unsure of.',
    },
  },
  required: ['reelTitle', 'mood', 'caption', 'hook', 'beats', 'payoff', 'commentPrompt', 'grounding'],
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

const SYSTEM = `You write scripts for short vertical videos about a single painting,
for an Instagram account whose reels reach millions of people.

THE FORMAT
One painting. The camera starts on the whole picture, then cuts between close
crops of details, pushing in or drifting across each one. A line of text sits
over the image for the whole of each shot. No voice-over. The text is the video.

THE SHAPE (this is measured from reels that went viral - follow it)

1. HOOK, over the whole painting, 4-6 seconds.
   It is not about the painting. It is about the act of looking, and it flatters
   the viewer for doing it, or it tells them they are looking at the wrong thing.
   Shapes that work:
     "Now I understand why people spend hours staring at the same painting."
     "Millions of people look at her smile, but he wanted you to see something else first."
     "Most people scroll past this. The people who stop see it immediately."
   Under 18 words. Present tense. No question marks.

2. THREE OR FOUR FAST BEATS, 4-6 seconds each, very short text - 5 to 12 words.
   Flat, declarative, naming what is there. Or the strongest opener of all, a
   subversion in two beats:
     "This looks romantic." then "It is not."
   Do not explain yet. Just place the pieces.

3. THE LONG MIDDLE, 9-14 seconds each, 18-38 words.
   Now the meaning. The reliable sentence shape is an object, then what it means:
     "Look at the hourglass on the table, because every grain is a move he can never take back."
     "Look closely at her hands, because she is not reaching for the bank."
   Point at something, then say the thing the viewer would not have thought of.
   Every beat in this section must change what the previous beat meant. If a beat
   only describes, cut it - description without meaning is what makes a reel boring.

4. PAYOFF, 8-10 seconds. An emotional reading, never a fact.
   "She is already grieving a man who is still alive."
   "Because shadows stay, after people disappear."
   This is the line the whole reel exists to earn. Write it first, then build
   backwards to it.

5. COMMENT PROMPT, 4-5 seconds, over the whole painting.
   "Let me know in the comments if I missed anything."
   "I'd love to know what you noticed first."

Total 10 to 14 beats, 75 to 115 seconds. Do not try to make it short. A reel is
boring when a beat says something the viewer could already see, not when it lasts
90 seconds.

VOICE
- First person and second person. "I", "you". Speak to one person.
- Present tense, casual, contractions. Write like someone typing, not a museum.
- Short lines. Three or four words per line on screen.
- Emotional words, unhedged: heartbreaking, never, already, disappear, alone.
- Name the artist mid-reel only when it makes the story better. Never open with
  the title. There is no title card, so do not write "and this is called...".
- Never: "hidden meaning", "masterpiece", "iconic", "let that sink in",
  "you won't believe", hashtags, emoji.

DRAMA AND TRUTH - the one rule that matters
Sensationalise the framing, the pacing and the reading. Never the facts.
"Shadows stay after people disappear" is a dramatic reading of a real gesture,
and it is allowed. Inventing a date, a name, a quotation, a diagnosis or an
incident is not, ever. This account's reach depends on the comments, and the
comments correct you. Everything you assert as fact must be either plainly
visible in the image or supported by the catalogue facts you are given. If a
reading is contested, you can still say it - as a reading: "the usual reading
is", "no one has settled". A true story told dramatically beats an invented one.

THE CAMERA
The image has a coordinate grid over it: lines every 0.1, numbered along the top
for x and down the left for y. The numbers are an overlay, not part of the
painting - never describe them.

For each beat name the "subject" first, then read its box off the grid.
- Read the subject's left, right, top and bottom edges against the numbered
  lines and give "focus" as x, y, w, h in those units. A beat about a glove that
  lands on empty carpet is the worst failure this script can have.
- Check every box before moving on. Does x to x+w, y to y+h really contain it?
  If you cannot locate something, cut that beat and write about something else.
- Crop tight: a face, a hand or an object is usually 0.12 to 0.30 of the width.
- The hook, the payoff and the comment prompt show the whole painting; their
  coordinates are set for you.
- "in" pushes closer, "out" pulls back, "left"/"right"/"up"/"down" drift,
  "hold" is nearly still. Vary them.
- "captionPos" is a hint only - the renderer places text clear of your crop.`;

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

Length: a hook, then ${beatCount} beats, then a payoff and a comment prompt.
Write the payoff first, then the beats that earn it, then the hook last.

Pace it on a curve, not a flat rate. The first three or four beats are short and
fast - 4 to 6 seconds, 5 to 12 words. The later beats are long - 9 to 14 seconds,
18 to 38 words. Set "seconds" so the text reads comfortably at about 2.5 words
per second, and so the whole reel lands between 75 and 115 seconds.

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
      subject: String(b?.subject || '').trim(),
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

  // The opening shot is always the whole painting. A reel that starts on a crop
  // asks the viewer to read a detail before they know what they are looking at.
  const hook = beat(raw?.hook, 'center');
  hook.focus = { x: 0, y: 0, w: 1, h: 1 };

  const MOODS = ['elegy', 'tenderness', 'unease', 'menace', 'wonder', 'melancholy', 'grandeur', 'stillness'];

  // The comment prompt closes the reel over the whole painting, like the hook.
  const prompt = raw?.commentPrompt
    ? {
        ...beat({ text: raw.commentPrompt, seconds: 4.5, motion: 'hold' }, 'center'),
        focus: { x: 0, y: 0, w: 1, h: 1 },
        role: 'prompt',
      }
    : null;

  return {
    reelTitle: String(raw?.reelTitle || '').trim(),
    mood: MOODS.includes(raw?.mood) ? raw.mood : 'stillness',
    caption: String(raw?.caption || '').trim(),
    grounding: String(raw?.grounding || '').trim(),
    beats: pace(
      [
        { ...hook, role: 'hook' },
        ...beats.filter((b) => b.text).map((b) => ({ ...b, role: 'beat' })),
        { ...beat(raw?.payoff, 'lower'), role: 'payoff' },
        ...(prompt ? [prompt] : []),
      ].filter((b) => b.text),
    ),
  };
}

/**
 * The measured reels open staccato and slow down: 4-5s for the first shots,
 * 9-14s later. Asked for that curve a model mostly delivers it, but a flat
 * script is the failure that makes a reel drag exactly where attention is won
 * or lost. This clamps each beat into the band its position calls for, and
 * never shortens one below what it takes to read.
 */
function pace(beats) {
  const body = beats.filter((b) => b.role === 'beat');
  const fastCount = Math.min(4, Math.max(1, Math.ceil(body.length / 3)));

  return beats.map((b) => {
    const readable = readingSeconds(b.text);
    if (b.role === 'hook') return { ...b, seconds: clamp(readable, 4, 7) };
    if (b.role === 'prompt') return { ...b, seconds: clamp(readable, 4, 6) };
    if (b.role === 'payoff') return { ...b, seconds: clamp(readable, 7, 11) };
    const [lo, hi] = body.indexOf(b) < fastCount ? [4, 7] : [8, 14];
    return { ...b, seconds: clamp(Math.max(readable, lo), lo, Math.max(hi, readable)) };
  });
}

/** Words at ~2.5 per second, plus a moment to take it in. */
function readingSeconds(text) {
  return String(text).trim().split(/\s+/).filter(Boolean).length / 2.5 + 1.2;
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
