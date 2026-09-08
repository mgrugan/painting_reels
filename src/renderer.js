/**
 * The camera and the burnt-in captions.
 *
 * A reel is a list of shots. Each shot owns a slice of the timeline, a start and
 * end view rectangle in painting pixels, and a caption. Drawing a frame is
 * therefore stateless: given a time, work out which shot is on screen, ease
 * between its two rectangles, and blit that region of the painting into the
 * frame.
 */

const FADE_IN = 0.4;
const FADE_OUT = 0.5;
const TITLE_CARD_SECONDS = 4.2;

/**
 * @param {object} script  from writeScript()
 * @param {HTMLImageElement} img
 * @param {object} opts    { width, height, motion, showTitleCard, painting }
 */
export function buildTimeline(script, img, opts) {
  const { width: CW, height: CH } = opts;
  const aspect = CW / CH;
  const amp = (opts.motion ?? 12) / 100;
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;

  let t = 0;
  const shots = script.beats.map((beat) => {
    const frame = frameRect(beat.focus, iw, ih, aspect);
    const [from, to] = moveRects(frame, beat.motion, amp, iw, ih);
    const shot = {
      kind: 'beat',
      start: t,
      end: t + beat.seconds,
      from,
      to,
      text: beat.text,
      captionPos: opts.capPos && opts.capPos !== 'auto' ? opts.capPos : beat.captionPos,
    };
    t = shot.end;
    return shot;
  });

  if (opts.showTitleCard && opts.painting) {
    shots.push({
      kind: 'title',
      start: t,
      end: t + TITLE_CARD_SECONDS,
      painting: opts.painting,
    });
    t += TITLE_CARD_SECONDS;
  }

  return { shots, duration: t, img, opts };
}

export function drawFrame(ctx, timeline, time) {
  const { opts } = timeline;
  const CW = opts.width;
  const CH = opts.height;

  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, CW, CH);

  const shot =
    timeline.shots.find((s) => time >= s.start && time < s.end) ||
    timeline.shots[timeline.shots.length - 1];

  if (shot) {
    if (shot.kind === 'title') {
      drawTitleCard(ctx, timeline, shot, time);
    } else {
      const local = shot.end === shot.start ? 0 : (time - shot.start) / (shot.end - shot.start);
      const p = easeInOut(clamp01(local));
      const view = lerpRect(shot.from, shot.to, p);
      drawView(ctx, timeline.img, view, CW, CH);
      drawCaption(ctx, shot.text, shot.captionPos, opts);
    }
  }

  if (opts.watermark) drawWatermark(ctx, opts);

  // A short dip in and out keeps the export from starting on a hard flash.
  const fade =
    Math.min(1, time / FADE_IN) *
    Math.min(1, Math.max(0, timeline.duration - time) / FADE_OUT);
  if (fade < 1) {
    ctx.fillStyle = `rgba(0,0,0,${1 - clamp01(fade)})`;
    ctx.fillRect(0, 0, CW, CH);
  }

  ctx.restore();
}

/* ── camera ─────────────────────────────────────────────────────────────── */

/**
 * Grows a focus region towards the screen aspect so details fill the frame.
 * A region that cannot reach 9:16 without leaving the painting stays as it is
 * and gets letterboxed, which is how the reference reels look on wide canvases.
 */
function frameRect(focus, iw, ih, aspect) {
  let w = focus.w * iw;
  let h = focus.h * ih;
  let cx = (focus.x + focus.w / 2) * iw;
  let cy = (focus.y + focus.h / 2) * ih;

  if (w / h > aspect) {
    h = Math.min(ih, w / aspect);
  } else {
    w = Math.min(iw, h * aspect);
  }

  // A crop that is a hair off the edge should slide in, not be squashed.
  cx = Math.min(iw - w / 2, Math.max(w / 2, cx));
  cy = Math.min(ih - h / 2, Math.max(h / 2, cy));

  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

function moveRects(rect, motion, amp, iw, ih) {
  const zoom = 1 + amp;
  const drift = amp * 0.75;

  const scaled = (k) => contain(scaleRect(rect, k), iw, ih);
  const shifted = (dx, dy, k) =>
    contain(offsetRect(scaleRect(rect, k), dx * rect.w, dy * rect.h), iw, ih);

  switch (motion) {
    case 'out':
      return [scaled(1), scaled(zoom)];
    case 'left':
      return [shifted(drift, 0, 1.04), shifted(-drift, 0, 1.04)];
    case 'right':
      return [shifted(-drift, 0, 1.04), shifted(drift, 0, 1.04)];
    case 'up':
      return [shifted(0, drift, 1.04), shifted(0, -drift, 1.04)];
    case 'down':
      return [shifted(0, -drift, 1.04), shifted(0, drift, 1.04)];
    case 'hold':
      return [scaled(1.02), scaled(1)];
    case 'in':
    default:
      return [scaled(zoom), scaled(1)];
  }
}

const scaleRect = (r, k) => ({
  x: r.x + (r.w - r.w * k) / 2,
  y: r.y + (r.h - r.h * k) / 2,
  w: r.w * k,
  h: r.h * k,
});

const offsetRect = (r, dx, dy) => ({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h });

/** Keeps a view inside the painting, shrinking it only if it has outgrown it. */
function contain(r, iw, ih) {
  let { x, y, w, h } = r;
  if (w > iw) {
    const k = iw / w;
    w *= k;
    h *= k;
  }
  if (h > ih) {
    const k = ih / h;
    w *= k;
    h *= k;
  }
  x = Math.min(iw - w, Math.max(0, x));
  y = Math.min(ih - h, Math.max(0, y));
  return { x, y, w, h };
}

const lerp = (a, b, p) => a + (b - a) * p;
const lerpRect = (a, b, p) => ({
  x: lerp(a.x, b.x, p),
  y: lerp(a.y, b.y, p),
  w: lerp(a.w, b.w, p),
  h: lerp(a.h, b.h, p),
});

const easeInOut = (p) => 0.5 - Math.cos(Math.PI * p) / 2;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

function drawView(ctx, img, view, CW, CH) {
  const scale = Math.min(CW / view.w, CH / view.h);
  const dw = view.w * scale;
  const dh = view.h * scale;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, view.x, view.y, view.w, view.h, (CW - dw) / 2, (CH - dh) / 2, dw, dh);
}

/* ── type ───────────────────────────────────────────────────────────────── */

function captionFont(opts, size) {
  return (opts.fontFamily || '700 %spx "Helvetica Neue", Helvetica, Arial, sans-serif').replace(
    '%s',
    String(Math.round(size)),
  );
}

function drawCaption(ctx, text, position, opts) {
  if (!text) return;

  const CW = opts.width;
  const CH = opts.height;
  const scale = CH / 1280;
  let size = (opts.fontSize || 52) * scale;
  const maxWidth = CW * 0.86;

  // Long beats shrink a little rather than running off the bottom of the frame.
  let lines = wrap(ctx, text, maxWidth, captionFont(opts, size));
  while (lines.length > 6 && size > 26 * scale) {
    size *= 0.92;
    lines = wrap(ctx, text, maxWidth, captionFont(opts, size));
  }

  const lineHeight = size * 1.22;
  const blockHeight = lines.length * lineHeight;

  let top;
  if (position === 'top') top = CH * 0.11;
  else if (position === 'lower') top = CH * 0.8 - blockHeight;
  else top = (CH - blockHeight) / 2;
  top = Math.min(CH - blockHeight - CH * 0.06, Math.max(CH * 0.06, top));

  ctx.font = captionFont(opts, size);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = size * 0.35;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = size * 0.17;
  lines.forEach((line, i) => ctx.strokeText(line, CW / 2, top + i * lineHeight));
  ctx.restore();

  ctx.fillStyle = '#fff';
  lines.forEach((line, i) => ctx.fillText(line, CW / 2, top + i * lineHeight));
}

function wrap(ctx, text, maxWidth, font) {
  ctx.font = font;
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
  }
  return lines.length ? lines : [''];
}

function drawWatermark(ctx, opts) {
  const scale = opts.height / 1280;
  ctx.save();
  ctx.font = captionFont(opts, 19 * scale);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,255,255,0.42)';
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 6 * scale;
  ctx.fillText(opts.watermark, opts.width / 2, opts.height * 0.9);
  ctx.restore();
}

function drawTitleCard(ctx, timeline, shot, time) {
  const { opts, img } = timeline;
  const CW = opts.width;
  const CH = opts.height;
  const scale = CH / 1280;
  const p = clamp01((time - shot.start) / 0.5);

  ctx.save();
  ctx.globalAlpha = p;

  const boxTop = CH * 0.2;
  const boxHeight = CH * 0.56;
  const k = Math.min((CW * 0.82) / img.naturalWidth, boxHeight / img.naturalHeight);
  const dw = img.naturalWidth * k;
  const dh = img.naturalHeight * k;
  ctx.drawImage(img, (CW - dw) / 2, boxTop + (boxHeight - dh) / 2, dw, dh);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';

  ctx.font = captionFont(opts, 44 * scale);
  const title = shot.painting.title;
  ctx.fillText(title, CW / 2, CH * 0.145);

  ctx.font = captionFont(opts, 30 * scale);
  ctx.fillStyle = 'rgba(255,255,255,0.78)';
  const by = [shot.painting.artist, shot.painting.year].filter(Boolean).join(', ');
  if (by) ctx.fillText(by, CW / 2, CH * 0.185);

  if (shot.painting.museum) {
    ctx.font = captionFont(opts, 22 * scale);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillText(shot.painting.museum, CW / 2, CH * 0.82);
  }

  ctx.restore();
}
