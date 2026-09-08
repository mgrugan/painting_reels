/**
 * Canvas → video file, entirely in the tab.
 *
 * MediaRecorder timestamps frames off the wall clock, so the render loop runs in
 * real time: a 100-second reel takes 100 seconds to export, and the preview you
 * watch is the file you get. That also lets an audio track be mixed in live.
 */

import { drawFrame } from './renderer.js';
import { patchWebmDuration } from './webm.js';

/**
 * First container the browser will actually write, best first.
 *
 * Every MP4 entry names H.264 explicitly. Bare `video/mp4` reports as supported
 * in Chromium builds that ship no H.264 encoder, and then writes VP9 into an
 * MP4 container — a file with the right extension that Instagram, TikTok and
 * most players refuse. Better to hand back an honest WebM.
 */
const CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1.4D401F,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4;codecs=avc1',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  return CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) || null;
}

/** 'mp4' or 'webm' — what this browser will actually produce. */
export function outputFormat() {
  const type = pickMimeType();
  if (!type) return null;
  return type.startsWith('video/mp4') ? 'mp4' : 'webm';
}

export function isSupported() {
  return Boolean(pickMimeType()) && typeof HTMLCanvasElement.prototype.captureStream === 'function';
}

/**
 * @param {object} args
 * @param {HTMLCanvasElement} args.canvas
 * @param {object} args.timeline
 * @param {number} args.fps
 * @param {ArrayBuffer|null} args.audioBuffer  decoded music, or null
 * @param {number} args.audioGain             0..1
 * @param {(p:number)=>void} args.onProgress
 * @param {(hidden:boolean)=>void} args.onHidden  the tab went away / came back
 * @param {AbortSignal} args.signal
 * @returns {Promise<{blob: Blob, mimeType: string, extension: string}>}
 */
export async function record({
  canvas,
  timeline,
  fps,
  audioBuffer = null,
  audioGain = 0.35,
  onProgress = () => {},
  onHidden = () => {},
  signal,
}) {
  const mimeType = pickMimeType();
  if (!mimeType) throw new Error('This browser cannot record video from a canvas.');

  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(fps);

  let audio = null;
  if (audioBuffer) {
    audio = buildAudio(audioBuffer, timeline.duration, audioGain);
    for (const track of audio.stream.getAudioTracks()) stream.addTrack(track);
  }

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: bitrateFor(timeline.opts.width, timeline.opts.height),
  });

  const chunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size) chunks.push(event.data);
  };

  const finished = new Promise((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = (event) => reject(event.error || new Error('Recording failed.'));
  });

  recorder.start(1000);
  audio?.start();

  const started = performance.now();
  let stopped = false;
  let hiddenSince = 0;
  let hiddenTotal = 0;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    document.removeEventListener('visibilitychange', onVisibility);
    audio?.stop();
    if (recorder.state !== 'inactive') recorder.stop();
    stream.getTracks().forEach((track) => track.stop());
  };

  /**
   * Browsers stop firing requestAnimationFrame in a background tab, which would
   * strand a long render halfway with no file and no error. Pause the recorder
   * and the clock together when the tab goes away, and pick both up on return,
   * so leaving the tab costs wall-clock time but never the export.
   */
  function onVisibility() {
    if (stopped) return;
    if (document.hidden) {
      hiddenSince = performance.now();
      if (recorder.state === 'recording') recorder.pause();
      audio?.suspend();
      onHidden(true);
    } else {
      hiddenTotal += performance.now() - hiddenSince;
      hiddenSince = 0;
      if (recorder.state === 'paused') recorder.resume();
      audio?.resume();
      onHidden(false);
      requestAnimationFrame(tick);
    }
  }

  let resolveLoop;
  const loop = new Promise((resolve) => {
    resolveLoop = resolve;
  });

  function tick() {
    if (stopped) return;
    if (document.hidden) return; // onVisibility restarts the loop
    const time = (performance.now() - started - hiddenTotal) / 1000;
    if (time >= timeline.duration) {
      // Hold the final frame briefly so the last shot is not clipped.
      drawFrame(ctx, timeline, timeline.duration);
      onProgress(1);
      setTimeout(() => {
        stop();
        resolveLoop();
      }, 180);
      return;
    }
    drawFrame(ctx, timeline, time);
    onProgress(time / timeline.duration);
    requestAnimationFrame(tick);
  }

  signal?.addEventListener('abort', () => {
    stop();
    resolveLoop();
  }, { once: true });

  document.addEventListener('visibilitychange', onVisibility);
  requestAnimationFrame(tick);

  await loop;
  await finished;

  if (signal?.aborted) throw new DOMException('Render cancelled', 'AbortError');

  const isMp4 = mimeType.startsWith('video/mp4');
  let blob = new Blob(chunks, { type: mimeType });
  if (!blob.size) {
    throw new Error(
      'The recorder produced an empty file. This usually means the tab lost focus for ' +
        'the whole render — try again and leave this tab in front.',
    );
  }
  if (!isMp4) blob = await patchWebmDuration(blob, timeline.duration);

  return { blob, mimeType, extension: isMp4 ? 'mp4' : 'webm' };
}

function bitrateFor(width, height) {
  return width >= 1080 ? 9_000_000 : 5_000_000;
}

/**
 * Loops the track to cover the reel and fades it out at the end, so a 30-second
 * clip can score a two-minute video without stopping halfway.
 */
function buildAudio(audioBuffer, duration, gain) {
  const context = new (window.AudioContext || window.webkitAudioContext)();
  const destination = context.createMediaStreamDestination();
  const source = context.createBufferSource();
  source.buffer = audioBuffer;
  source.loop = true;

  const volume = context.createGain();
  volume.gain.value = gain;
  source.connect(volume).connect(destination);

  return {
    stream: destination.stream,
    start() {
      // Autoplay policy can leave a fresh context suspended even inside a click.
      if (context.state === 'suspended') context.resume();
      const now = context.currentTime;
      volume.gain.setValueAtTime(0, now);
      volume.gain.linearRampToValueAtTime(gain, now + 1.2);
      volume.gain.setValueAtTime(gain, now + Math.max(1.5, duration - 2));
      volume.gain.linearRampToValueAtTime(0.0001, now + duration);
      source.start();
    },
    suspend() {
      if (context.state === 'running') context.suspend();
    },
    resume() {
      if (context.state === 'suspended') context.resume();
    },
    stop() {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
      context.close();
    },
  };
}

export async function decodeAudioFile(file) {
  const context = new (window.AudioContext || window.webkitAudioContext)();
  try {
    return await context.decodeAudioData(await file.arrayBuffer());
  } finally {
    context.close();
  }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
