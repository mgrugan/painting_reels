/**
 * Wiring: settings ⇄ sidebar, library ⇄ grid, script ⇄ preview ⇄ export.
 */

import { PAINTINGS } from './paintings.js';
import { DEFAULTS, loadSettings, saveSettings, loadApiKey, rememberApiKey, forgetApiKey } from './store.js';
import { estimateCost, testKey, AnthropicError } from './anthropic.js';
import { writeScript, estimateTokens } from './script.js';
import { loadImage, toModelImage, readFileAsDataUrl } from './images.js';
import { buildTimeline, drawFrame } from './renderer.js';
import { record, decodeAudioFile, downloadBlob, isSupported, outputFormat } from './recorder.js';

const $ = (id) => document.getElementById(id);

const state = {
  settings: loadSettings(),
  apiKey: loadApiKey(),
  library: PAINTINGS.slice(),
  filtered: PAINTINGS.slice(),
  selected: null,
  image: null,
  script: null,
  timeline: null,
  audioBuffer: null,
  playing: false,
  playHead: 0,
  busy: false,
  abort: null,
};

const canvas = $('canvas');
const ctx = canvas.getContext('2d');

/* ── settings ───────────────────────────────────────────────────────────── */

const CONTROLS = {
  model: 'value', effort: 'value', voice: 'value', beats: 'number', secs: 'number',
  strictFacts: 'checked', res: 'value', fps: 'value', motion: 'number',
  showTitleCard: 'checked', fontFamily: 'value', fontSize: 'number', capPos: 'value',
  watermark: 'value', musicVol: 'number',
};

function applySettingsToForm() {
  for (const [id, kind] of Object.entries(CONTROLS)) {
    const el = $(id);
    if (!el) continue;
    const value = state.settings[id] ?? DEFAULTS[id];
    if (kind === 'checked') el.checked = Boolean(value);
    else el.value = String(value);
  }
  refreshLabels();
}

function readForm() {
  for (const [id, kind] of Object.entries(CONTROLS)) {
    const el = $(id);
    if (!el) continue;
    state.settings[id] = kind === 'checked' ? el.checked : kind === 'number' ? Number(el.value) : el.value;
  }
  saveSettings(state.settings);
  refreshLabels();
}

function refreshLabels() {
  const s = state.settings;
  $('beatsVal').textContent = s.beats;
  $('secsVal').textContent = `${s.secs}s`;
  $('motionVal').textContent = `${s.motion}%`;
  $('fontSizeVal').textContent = s.fontSize;
  $('musicVolVal').textContent = `${s.musicVol}%`;
  $('effortVal').textContent = s.effort;

  // Haiku predates the effort parameter, so the control does nothing there.
  const usesEffort = s.model !== 'claude-haiku-4-5';
  $('effort').disabled = !usesEffort;
  $('effortVal').textContent = usesEffort ? s.effort : 'n/a';

  const { input, output } = estimateTokens(s.beats, s.model, s.effort);
  const cost = estimateCost(s.model, input, output);
  $('costEst').textContent = cost == null ? '—' : cost < 0.01 ? 'under 1¢' : `about ${(cost * 100).toFixed(1)}¢`;
}

/* ── library ────────────────────────────────────────────────────────────── */

function renderGrid() {
  const grid = $('grid');
  grid.textContent = '';
  const fragment = document.createDocumentFragment();

  for (const painting of state.filtered) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'card';
    card.setAttribute('aria-selected', String(state.selected?.id === painting.id));
    card.title = `${painting.title} — ${painting.artist}`;

    const thumb = document.createElement('span');
    thumb.className = 'thumb';
    thumb.style.backgroundImage = `url("${painting.src}")`;

    const meta = document.createElement('span');
    meta.className = 'meta';
    const title = document.createElement('span');
    title.className = 't';
    title.textContent = painting.title;
    const artist = document.createElement('span');
    artist.className = 'a';
    artist.textContent = `${painting.artist}${painting.year ? `, ${painting.year}` : ''}`;
    meta.append(title, artist);

    card.append(thumb, meta);
    card.addEventListener('click', () => select(painting));
    fragment.append(card);
  }

  grid.append(fragment);
  $('gridCount').textContent = `${state.filtered.length} of ${state.library.length}`;
  $('libCount').textContent = String(state.library.length);
}

function filterLibrary(query) {
  const q = query.trim().toLowerCase();
  state.filtered = !q
    ? state.library.slice()
    : state.library.filter((p) =>
        [p.title, p.artist, p.year, p.museum, ...(p.tags || [])]
          .join(' ')
          .toLowerCase()
          .includes(q),
      );
  renderGrid();
}

async function select(painting) {
  state.selected = painting;
  state.script = null;
  state.timeline = null;
  stopPlayback();
  renderGrid();
  $('script').hidden = true;
  $('generateBtn').disabled = state.busy;
  $('renderBtn').disabled = true;
  $('playBtn').disabled = true;
  $('scrub').disabled = true;

  try {
    state.image = await loadImage(painting.src);
    drawPoster();
  } catch (err) {
    state.image = null;
    toast(err.message, true);
  }
}

/** Shows the chosen painting in the phone frame before any script exists. */
function drawPoster() {
  if (!state.image) return;
  sizeCanvas();
  const { width: CW, height: CH } = canvas;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, CW, CH);
  const img = state.image;
  const k = Math.min(CW / img.naturalWidth, CH / img.naturalHeight);
  const dw = img.naturalWidth * k;
  const dh = img.naturalHeight * k;
  ctx.drawImage(img, (CW - dw) / 2, (CH - dh) / 2, dw, dh);
  $('phoneEmpty').hidden = true;
}

function sizeCanvas() {
  const width = Number(state.settings.res) === 1080 ? 1080 : 720;
  const height = width === 1080 ? 1920 : 1280;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

/* ── generating ─────────────────────────────────────────────────────────── */

async function generate() {
  if (!state.selected) return toast('Pick a painting first.');
  if (!state.apiKey) return toast('Add your Anthropic API key in the sidebar.', true);
  if (!state.image) return toast('That painting has not loaded yet.', true);

  setBusy(true, 'Writing…');
  state.abort = new AbortController();

  try {
    const small = toModelImage(state.image);
    const { script, usage } = await writeScript({
      apiKey: state.apiKey,
      model: state.settings.model,
      effort: state.settings.effort,
      painting: state.selected,
      imageBase64: small.base64,
      mediaType: small.mediaType,
      voice: state.settings.voice,
      beatCount: state.settings.beats,
      seconds: state.settings.secs,
      strictFacts: state.settings.strictFacts,
      signal: state.abort.signal,
    });

    if (!script.beats.length) throw new Error('The model returned an empty script.');

    state.script = script;
    renderScript(usage);
    rebuildTimeline();
    seek(0);
    toast(`Script ready — ${script.beats.length} shots, ${fmt(state.timeline.duration)}.`);
  } catch (err) {
    if (err?.name === 'AbortError') return;
    toast(describe(err), true);
  } finally {
    state.abort = null;
    setBusy(false);
  }
}

function describe(err) {
  if (err instanceof AnthropicError) {
    if (err.status === 401) return 'That API key was rejected. Check it and try again.';
    if (err.status === 429) return 'Rate limited by the API. Wait a moment and retry.';
    if (err.status === 400 && /credit|balance/i.test(err.message)) return err.message;
    return err.message;
  }
  return err?.message || 'Something went wrong.';
}

function renderScript(usage) {
  const script = state.script;
  $('script').hidden = false;
  $('scriptTitle').textContent = script.reelTitle || 'Script';

  const cost = estimateCost(
    state.settings.model,
    (usage?.input_tokens || 0) + (usage?.cache_read_input_tokens || 0),
    usage?.output_tokens || 0,
  );
  const parts = [`${script.beats.length} shots`];
  if (usage?.input_tokens) parts.push(`${usage.input_tokens} in / ${usage.output_tokens} out`);
  if (cost != null) parts.push(cost < 0.01 ? 'under 1¢' : `${(cost * 100).toFixed(1)}¢`);
  $('scriptMeta').textContent = parts.join(' · ');
  $('sourcesNote').textContent = script.grounding ? `Grounding: ${script.grounding}` : '';

  const list = $('beatList');
  list.textContent = '';

  script.beats.forEach((beat, index) => {
    const item = document.createElement('li');
    item.className = 'beat';
    item.dataset.index = String(index);

    const head = document.createElement('div');
    head.className = 'beat-head';
    const label = document.createElement('span');
    label.textContent = beat.role === 'hook' ? 'Hook' : beat.role === 'payoff' ? 'Payoff' : `Shot ${index + 1}`;
    const detail = document.createElement('span');
    detail.textContent = `${beat.motion} · ${beat.seconds.toFixed(1)}s · ${beat.captionPos}`;
    head.append(label, detail);

    const area = document.createElement('textarea');
    area.value = beat.text;
    area.rows = 1;
    area.addEventListener('input', () => {
      beat.text = area.value;
      autoGrow(area);
      rebuildTimeline();
      seek(state.timeline.shots[index]?.start ?? 0);
    });
    area.addEventListener('focus', () => {
      markCurrent(index);
      seek(state.timeline.shots[index]?.start ?? 0);
    });

    item.append(head, area);
    item.addEventListener('click', () => {
      markCurrent(index);
      seek(state.timeline.shots[index]?.start ?? 0);
    });
    list.append(item);
    autoGrow(area);
  });
}

function autoGrow(area) {
  area.style.height = 'auto';
  area.style.height = `${area.scrollHeight}px`;
}

function markCurrent(index) {
  for (const el of $('beatList').children) {
    el.setAttribute('aria-current', String(Number(el.dataset.index) === index));
  }
}

/* ── preview and export ─────────────────────────────────────────────────── */

function rebuildTimeline() {
  if (!state.script || !state.image) return;
  sizeCanvas();
  state.timeline = buildTimeline(state.script, state.image, {
    width: canvas.width,
    height: canvas.height,
    motion: state.settings.motion,
    showTitleCard: state.settings.showTitleCard,
    painting: state.selected,
    fontFamily: state.settings.fontFamily,
    fontSize: state.settings.fontSize,
    capPos: state.settings.capPos,
    watermark: state.settings.watermark.trim(),
  });
  $('renderBtn').disabled = state.busy || !isSupported();
  $('playBtn').disabled = false;
  $('scrub').disabled = false;
  updateTimecode();
}

function seek(time) {
  if (!state.timeline) return;
  state.playHead = Math.min(state.timeline.duration, Math.max(0, time));
  drawFrame(ctx, state.timeline, state.playHead);
  $('scrub').value = String(Math.round((state.playHead / state.timeline.duration) * 1000));
  updateTimecode();
  $('phoneEmpty').hidden = true;
}

function updateTimecode() {
  if (!state.timeline) return;
  $('timecode').textContent = `${fmt(state.playHead)} / ${fmt(state.timeline.duration)}`;
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

let rafId = 0;
function startPlayback() {
  if (!state.timeline || state.playing) return;
  state.playing = true;
  $('playBtn').textContent = 'Pause';
  const origin = performance.now() - state.playHead * 1000;
  const tick = () => {
    if (!state.playing) return;
    const time = (performance.now() - origin) / 1000;
    if (time >= state.timeline.duration) {
      seek(0);
      stopPlayback();
      return;
    }
    seek(time);
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

function stopPlayback() {
  state.playing = false;
  cancelAnimationFrame(rafId);
  $('playBtn').textContent = 'Play';
}

async function renderVideo() {
  if (!state.timeline) return;
  if (!isSupported()) return toast('This browser cannot record video from a canvas. Try Chrome or Edge.', true);

  stopPlayback();
  setBusy(true, 'Rendering…');
  state.abort = new AbortController();
  $('cancelRenderBtn').hidden = false;
  $('progress').hidden = false;

  try {
    const { blob, extension } = await record({
      canvas,
      timeline: state.timeline,
      fps: Number(state.settings.fps),
      audioBuffer: state.audioBuffer,
      audioGain: state.settings.musicVol / 100,
      signal: state.abort.signal,
      onProgress: (p) => {
        $('progressBar').style.width = `${(p * 100).toFixed(1)}%`;
      },
    });
    const name = slug(state.script.reelTitle || state.selected.title);
    downloadBlob(blob, `${name}.${extension}`);
    toast(`Saved ${name}.${extension} — ${(blob.size / 1e6).toFixed(1)} MB.`);
  } catch (err) {
    if (err?.name !== 'AbortError') toast(err.message || 'Rendering failed.', true);
  } finally {
    state.abort = null;
    $('cancelRenderBtn').hidden = true;
    $('progress').hidden = true;
    $('progressBar').style.width = '0%';
    setBusy(false);
    seek(0);
  }
}

const slug = (s) =>
  s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) ||
  'painting-reel';

function setBusy(busy, label) {
  state.busy = busy;
  const generateBtn = $('generateBtn');
  generateBtn.disabled = busy || !state.selected;
  generateBtn.textContent = busy && label === 'Writing…' ? label : 'Generate reel';
  $('renderBtn').disabled = busy || !state.timeline || !isSupported();
  $('rewriteBtn').disabled = busy;
  $('randomBtn').disabled = busy;
}

/* ── chrome ─────────────────────────────────────────────────────────────── */

let toastTimer = 0;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('err', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, isError ? 7000 : 4000);
}

function bind() {
  for (const id of Object.keys(CONTROLS)) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener('input', () => {
      readForm();
      if (['res', 'fps'].includes(id)) sizeCanvas();
      if (state.script) {
        rebuildTimeline();
        seek(state.playHead);
      } else {
        drawPoster();
      }
    });
  }

  $('apiKey').addEventListener('input', (event) => {
    state.apiKey = event.target.value.trim();
    if ($('rememberKey').checked) rememberApiKey(state.apiKey);
    $('keyStatus').textContent = '';
    $('generateBtn').disabled = state.busy || !state.selected;
  });

  $('rememberKey').addEventListener('change', (event) => {
    if (event.target.checked) rememberApiKey(state.apiKey);
    else forgetApiKey();
  });

  $('keyReveal').addEventListener('click', () => {
    const field = $('apiKey');
    const hidden = field.type === 'password';
    field.type = hidden ? 'text' : 'password';
    $('keyReveal').textContent = hidden ? 'hide' : 'show';
  });

  $('forgetKey').addEventListener('click', () => {
    forgetApiKey();
    state.apiKey = '';
    $('apiKey').value = '';
    $('rememberKey').checked = false;
    setStatus('Key cleared from this browser.', 'ok');
  });

  $('testKey').addEventListener('click', async () => {
    if (!state.apiKey) return setStatus('Paste a key first.', 'err');
    setStatus('Checking…');
    try {
      await testKey(state.apiKey, state.settings.model);
      setStatus('Key works.', 'ok');
    } catch (err) {
      setStatus(describe(err), 'err');
    }
  });

  $('search').addEventListener('input', (event) => filterLibrary(event.target.value));

  $('randomBtn').addEventListener('click', () => {
    const pool = state.filtered.length ? state.filtered : state.library;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    select(pick);
    document.querySelector('.card[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  });

  $('generateBtn').addEventListener('click', generate);
  $('rewriteBtn').addEventListener('click', generate);
  $('renderBtn').addEventListener('click', renderVideo);
  $('cancelRenderBtn').addEventListener('click', () => state.abort?.abort());

  $('playBtn').addEventListener('click', () => (state.playing ? stopPlayback() : startPlayback()));

  $('scrub').addEventListener('input', (event) => {
    if (!state.timeline) return;
    stopPlayback();
    seek((Number(event.target.value) / 1000) * state.timeline.duration);
  });

  $('copyScript').addEventListener('click', async () => {
    const text = state.script.beats.map((b) => b.text).join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('Script copied.');
    } catch {
      toast('Clipboard blocked by the browser.', true);
    }
  });

  $('musicFile').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      state.audioBuffer = null;
      $('musicNote').textContent = 'Optional. The file stays on your machine.';
      return;
    }
    try {
      state.audioBuffer = await decodeAudioFile(file);
      $('musicNote').textContent = `${file.name} — ${fmt(state.audioBuffer.duration)}, looped to fit.`;
    } catch {
      state.audioBuffer = null;
      $('musicNote').textContent = 'That audio file could not be decoded.';
    }
  });

  $('addOwn').addEventListener('click', () => $('ownFile').click());

  $('ownFile').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const dataUrl = await readFileAsDataUrl(file);
    const painting = {
      id: `own-${Date.now()}`,
      title: file.name.replace(/\.[^.]+$/, ''),
      artist: '',
      year: '',
      museum: '',
      tags: ['yours'],
      notes: '',
      src: dataUrl,
      page: '',
    };
    state.library = [painting, ...state.library];
    $('search').value = '';
    filterLibrary('');
    select(painting);
    toast('Added. With no catalogue facts, the model will describe only what it can see.');
  });

  $('menuBtn').addEventListener('click', () => $('sidebar').classList.toggle('open'));

  document.addEventListener('keydown', (event) => {
    if (event.target.matches('input, textarea, select')) return;
    if (event.code === 'Space' && state.timeline) {
      event.preventDefault();
      state.playing ? stopPlayback() : startPlayback();
    }
  });
}

function setStatus(text, kind = '') {
  const el = $('keyStatus');
  el.textContent = text;
  el.className = `status ${kind}`;
}

/* ── boot ───────────────────────────────────────────────────────────────── */

applySettingsToForm();
bind();
renderGrid();
sizeCanvas();

if (state.apiKey) {
  $('apiKey').value = state.apiKey;
  $('rememberKey').checked = true;
}

const format = outputFormat();
if (!format) {
  $('renderBtn').title = 'Canvas recording is unavailable in this browser.';
  toast('This browser cannot export video. Preview works; use Chrome, Edge or Safari to render.', true);
} else {
  $('renderBtn').textContent = `Render & download ${format.toUpperCase()}`;
  if (format === 'webm') {
    $('renderBtn').title =
      'This browser has no H.264 encoder, so the export is WebM. Instagram and TikTok ' +
      'want MP4 — either render in Safari or Chrome on macOS/Windows, or convert with ' +
      'ffmpeg -i reel.webm -c:v libx264 -pix_fmt yuv420p -c:a aac reel.mp4';
  }
}
