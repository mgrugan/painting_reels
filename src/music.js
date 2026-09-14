/**
 * The score.
 *
 * Classical *compositions* are almost all out of copyright; classical
 * *recordings* mostly are not, which is the real constraint on a library like
 * this. Every track below is a recording in the public domain or released CC0,
 * served from Wikimedia with `Access-Control-Allow-Origin: *` so the page can
 * fetch and decode it. Each is linked as the MP3 Wikimedia transcodes for it —
 * Safari will not decode Ogg Vorbis, and the originals are mostly Ogg.
 *
 * Tracks loop to cover the reel and fade out at the end, so a two-minute piece
 * scores a three-minute video without anyone noticing the seam.
 */

const T = 'https://upload.wikimedia.org/wikipedia/commons';

export const TRACKS = [
  {
    id: 'goldberg-aria',
    title: 'Goldberg Variations, BWV 988 — Aria',
    composer: 'J. S. Bach',
    performer: 'Aaron Dunn',
    licence: 'CC0',
    seconds: 145,
    url: `${T}/transcoded/f/f3/Aaron_Dunn_-_Goldberg_Variations_BWV_988_-_Aria.ogg/Aaron_Dunn_-_Goldberg_Variations_BWV_988_-_Aria.ogg.mp3`,
    note: 'Solo piano, unhurried. Sits under a quiet story without arguing with it.',
  },
  {
    id: 'gnossienne-3',
    title: 'Gnossienne No. 3',
    composer: 'Erik Satie',
    performer: 'Public-domain recording',
    licence: 'Public domain',
    seconds: 163,
    url: `${T}/transcoded/1/10/Gnossienne_3_%28Satie%29.ogg/Gnossienne_3_%28Satie%29.ogg.mp3`,
    note: 'Slow, circling, unresolved. The house style for "something is off here".',
  },
  {
    id: 'gnossienne-4',
    title: 'Gnossienne No. 4',
    composer: 'Erik Satie',
    performer: 'Public-domain recording',
    licence: 'Public domain',
    seconds: 139,
    url: `${T}/transcoded/e/e9/Gnossienne_4_%28Satie%29.ogg/Gnossienne_4_%28Satie%29.ogg.mp3`,
    note: 'Darker and more restless than No. 3.',
  },
  {
    id: 'gnossienne-5',
    title: 'Gnossienne No. 5',
    composer: 'Erik Satie',
    performer: 'Public-domain recording',
    licence: 'Public domain',
    seconds: 172,
    url: `${T}/transcoded/0/07/Gnossienne_5_%28Satie%29.ogg/Gnossienne_5_%28Satie%29.ogg.mp3`,
    note: 'Grave and level. Grief without swelling.',
  },
  {
    id: 'clair-de-lune-piano',
    title: 'Clair de lune, from Suite bergamasque',
    composer: 'Claude Debussy',
    performer: 'Public-domain recording',
    licence: 'Public domain',
    seconds: 304,
    url: `${T}/transcoded/b/be/Clair_de_lune_%28Claude_Debussy%29_Suite_bergamasque.ogg/Clair_de_lune_%28Claude_Debussy%29_Suite_bergamasque.ogg.mp3`,
    note: 'Opens outward. Longing, or the strangeness of a thing seen properly.',
  },
  {
    id: 'clair-de-lune-brass',
    title: 'Clair de Lune (brass ensemble)',
    composer: 'Claude Debussy',
    performer: 'Wright Brass, United States Air Force Band of Flight',
    licence: 'Public domain (work of the US federal government)',
    seconds: 240,
    url: `${T}/6/63/Clair_de_Lune_-_Wright_Brass_-_United_States_Air_Force_Band_of_Flight.mp3`,
    note: 'Warm brass. Ceremony and weight rather than intimacy.',
  },
  {
    id: 'toccata-bwv565',
    title: 'Toccata and Fugue in D minor, BWV 565',
    composer: 'J. S. Bach',
    performer: 'Public-domain recording',
    licence: 'Public domain',
    seconds: 514,
    url: `${T}/transcoded/b/be/Toccata_et_Fugue_BWV565.ogg/Toccata_et_Fugue_BWV565.ogg.mp3`,
    note: 'Organ. Unsubtle on purpose — for violence, horror and the sublime.',
  },
];

/**
 * Which piece plays for which mood.
 *
 * Six recordings across eight moods: two of them carry a second mood each,
 * chosen because the piece genuinely does both jobs rather than to fill the
 * table. Add a track to `TRACKS` and point a mood at it to change any of this.
 */
export const MOOD_TRACKS = {
  elegy: 'gnossienne-5',
  tenderness: 'goldberg-aria',
  unease: 'gnossienne-4',
  menace: 'toccata-bwv565',
  wonder: 'clair-de-lune-piano',
  melancholy: 'gnossienne-3',
  grandeur: 'clair-de-lune-brass',
  stillness: 'goldberg-aria',
};

export const MOOD_LABELS = {
  elegy: 'Elegy — a death, a loss, something already over',
  tenderness: 'Tenderness — intimacy, care, a private moment',
  unease: 'Unease — something is wrong and the picture is not saying what',
  menace: 'Menace — violence, threat, cruelty',
  wonder: 'Wonder — discovery, scale, strangeness',
  melancholy: 'Melancholy — longing, regret, time passing',
  grandeur: 'Grandeur — power, ceremony, spectacle',
  stillness: 'Stillness — a quiet, level look',
};

export function trackById(id) {
  return TRACKS.find((t) => t.id === id) || null;
}

export function trackForMood(mood) {
  return trackById(MOOD_TRACKS[mood]) || TRACKS[0];
}

/** Fetches and decodes a track. Cached, because a rerender should not refetch. */
const cache = new Map();

export async function loadTrack(track, signal) {
  if (cache.has(track.id)) return cache.get(track.id);
  const promise = (async () => {
    const res = await fetch(track.url, { signal, mode: 'cors' });
    if (!res.ok) throw new Error(`Could not fetch ${track.title} (${res.status}).`);
    const bytes = await res.arrayBuffer();
    const context = new (window.AudioContext || window.webkitAudioContext)();
    try {
      return await context.decodeAudioData(bytes);
    } finally {
      context.close();
    }
  })();
  cache.set(track.id, promise);
  promise.catch(() => cache.delete(track.id));
  return promise;
}
