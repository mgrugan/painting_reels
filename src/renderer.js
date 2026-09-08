/**
 * The camera and the burnt-in captions.
 *
 * A reel is a list of shots. Each shot owns a slice of the timeline, a start and
 * end view rectangle in painting pixels, and a caption. Drawing a frame is
 * therefore stateless: given a time, work out which shot is on screen, ease
 * between its two rectangles, and blit that region of the painting into the
 * frame.
 */

const TITLE_CARD_SECONDS = 4.2;

/** Fraction of the frame height a caption block may take before it shrinks. */
const CAPTION_MAX_HEIGHT = 0.34;

/** How far below centre the subject sits, to open a caption band above it. */
const SUBJECT_LIFT = 0.11;

/**
 * The title-safe area, as fractions of the frame.
 *
 * Instagram and TikTok lay their own furniture over the edges of a reel — the
 * caption, handle and buttons across the bottom, the profile and sound strip at
 * the top, the action rail down the right. Anything outside these insets is
 * liable to be sat on. Taken from a 1080 x 1920 template: 120px either side,
 * 250px off the top, 380px off the bottom.
 */
const SAFE = {
  left: 120 / 1080,
  right: 120 / 1080,
  top: 250 / 1920,
  bottom: 380 / 1920,
};

/** The safe rectangle in canvas pixels. */
function safeArea(CW, CH) {
  const x = CW * SAFE.left;
  const y = CH * SAFE.top;
  return { x, y, w: CW * (1 - SAFE.left - SAFE.right), h: CH * (1 - SAFE.top - SAFE.bottom) };
}

/** Height of the strip at the foot of the safe area kept clear for the handle. */
function watermarkStrip(opts) {
  return opts.watermark ? 18 * (opts.height / 1280) * 2.1 : 0;
}

/** The safe area minus anything already spoken for. */
function captionArea(opts) {
  const safe = safeArea(opts.width, opts.height);
  return { ...safe, h: safe.h - watermarkStrip(opts) };
}

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
    const subject = {
      x: beat.focus.x * iw,
      y: beat.focus.y * ih,
      w: beat.focus.w * iw,
      h: beat.focus.h * ih,
    };
    const shot = {
      kind: 'beat',
      start: t,
      end: t + beat.seconds,
      from,
      to,
      subject,
      text: beat.text,
      // Placement is decided once, from the middle of the move, so the caption
      // does not drift up and down while the camera pushes in.
      captionPos:
        opts.capPos && opts.capPos !== 'auto'
          ? opts.capPos
          : placeCaption(subject, lerpRect(from, to, 0.5), CW, CH, opts),
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
      drawTitleCard(ctx, timeline, shot);
    } else {
      const local = shot.end === shot.start ? 0 : (time - shot.start) / (shot.end - shot.start);
      const p = easeInOut(clamp01(local));
      const view = lerpRect(shot.from, shot.to, p);
      drawView(ctx, timeline.img, view, CW, CH);
      drawCaption(ctx, shot.text, shot.captionPos, opts);
    }
  }

  if (opts.watermark) drawWatermark(ctx, opts);

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
  const cx0 = (focus.x + focus.w / 2) * iw;
  const cy0 = (focus.y + focus.h / 2) * ih;

  if (w / h > aspect) {
    h = Math.min(ih, w / aspect);
  } else {
    w = Math.min(iw, h * aspect);
  }

  // Growing a crop to 9:16 leaves slack above and below the subject. Spending it
  // evenly centres the subject, which is the one place the caption cannot go, so
  // the slack is spent on one side to open a band for text. The subject sits a
  // little low and the band opens above it: Instagram and TikTok lay their own
  // controls over the bottom of the frame, so that is the worse place to put
  // words. Where the edge of the painting forbids the offset the crop slides in
  // and the caption takes whichever side is actually clear.
  const cx = Math.min(iw - w / 2, Math.max(w / 2, cx0));
  const cy = Math.min(ih - h / 2, Math.max(h / 2, cy0 - h * SUBJECT_LIFT));

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

/**
 * Where the subject lands on screen, given the region currently being shown.
 * Both rectangles are in painting pixels; the result is in canvas pixels and
 * may extend past the frame when the camera is pushed in past the subject.
 */
function projectRect(rect, view, CW, CH) {
  const scale = Math.min(CW / view.w, CH / view.h);
  const dx = (CW - view.w * scale) / 2;
  const dy = (CH - view.h * scale) / 2;
  return {
    x: dx + (rect.x - view.x) * scale,
    y: dy + (rect.y - view.y) * scale,
    w: rect.w * scale,
    h: rect.h * scale,
  };
}

/**
 * Keeps the caption off the thing the caption is about.
 *
 * The camera is always built around the subject, so the middle of the frame is
 * exactly where the text must not go. Measure the clear space above and below
 * the subject and take the roomier side; only fall back to the centre when the
 * subject fills the frame top to bottom and there is nowhere better.
 */
function placeCaption(subject, view, CW, CH, opts) {
  const safe = captionArea(opts);
  const box = projectRect(subject, view, CW, CH);
  // Space is only useful if a caption is allowed to sit in it.
  const above = Math.max(0, Math.min(box.y, safe.y + safe.h) - safe.y);
  const below = Math.max(0, safe.y + safe.h - Math.max(box.y + box.h, safe.y));
  const needed = safe.h * 0.26;

  // A subject that fills the frame — the opening full-painting shot, usually —
  // has no clear band at all. The lower third is the least destructive place to
  // put text over a whole picture: faces and hands are rarely down there.
  if (above < needed && below < needed) return 'lower';
  return below >= above ? 'lower' : 'top';
}

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
  const safe = captionArea(opts);
  const scale = CH / 1280;
  let size = (opts.fontSize || 38) * scale;
  const maxWidth = safe.w;

  // A long beat shrinks rather than growing a block that swallows the picture.
  let lines = wrap(ctx, text, maxWidth, captionFont(opts, size));
  while (lines.length * size * 1.22 > safe.h * CAPTION_MAX_HEIGHT && size > 22 * scale) {
    size *= 0.94;
    lines = wrap(ctx, text, maxWidth, captionFont(opts, size));
  }

  const lineHeight = size * 1.22;
  const blockHeight = lines.length * lineHeight;

  let top;
  if (position === 'top') top = safe.y;
  else if (position === 'lower') top = safe.y + safe.h - blockHeight;
  else top = safe.y + (safe.h - blockHeight) / 2;
  // Never leave the safe area, even for a block too tall to fit inside it.
  top = Math.max(safe.y, Math.min(safe.y + safe.h - blockHeight, top));

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
  const cx = safe.x + safe.w / 2;
  lines.forEach((line, i) => ctx.strokeText(line, cx, top + i * lineHeight));
  ctx.restore();

  ctx.fillStyle = '#fff';
  lines.forEach((line, i) => ctx.fillText(line, cx, top + i * lineHeight));
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
  const safe = safeArea(opts.width, opts.height);
  ctx.save();
  ctx.font = captionFont(opts, 18 * scale);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = 'rgba(255,255,255,0.42)';
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 6 * scale;
  ctx.fillText(opts.watermark, safe.x + safe.w / 2, safe.y + safe.h);
  ctx.restore();
}

function drawTitleCard(ctx, timeline, shot) {
  const { opts, img } = timeline;
  const CW = opts.width;
  const CH = opts.height;
  const scale = CH / 1280;

  // captionArea, not safeArea, so the credit line clears the watermark.
  const safe = captionArea(opts);
  const cx = safe.x + safe.w / 2;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  // A long title wraps to two lines, then shrinks, rather than running off the
  // edge of the frame.
  let titleSize = 38 * scale;
  let titleLines = wrap(ctx, shot.painting.title, safe.w, captionFont(opts, titleSize));
  while (titleLines.length > 2 && titleSize > 22 * scale) {
    titleSize *= 0.93;
    titleLines = wrap(ctx, shot.painting.title, safe.w, captionFont(opts, titleSize));
  }

  const bySize = 26 * scale;
  const creditSize = 20 * scale;
  const by = [shot.painting.artist, shot.painting.year].filter(Boolean).join(', ');

  const titleHeight = titleLines.length * titleSize * 1.2;
  const headerHeight = titleHeight + (by ? bySize * 1.7 : titleSize * 0.5);
  const footerHeight = shot.painting.museum ? creditSize * 2.4 : 0;

  const boxTop = safe.y + headerHeight;
  const boxHeight = safe.h - headerHeight - footerHeight;
  const k = Math.min(safe.w / img.naturalWidth, boxHeight / img.naturalHeight);
  const dw = img.naturalWidth * k;
  const dh = img.naturalHeight * k;
  ctx.drawImage(img, cx - dw / 2, boxTop + (boxHeight - dh) / 2, dw, dh);

  ctx.fillStyle = '#fff';
  ctx.font = captionFont(opts, titleSize);
  titleLines.forEach((line, i) => ctx.fillText(line, cx, safe.y + i * titleSize * 1.2));

  if (by) {
    ctx.font = captionFont(opts, bySize);
    ctx.fillStyle = 'rgba(255,255,255,0.78)';
    ctx.fillText(by, cx, safe.y + titleHeight + bySize * 0.2);
  }

  if (shot.painting.museum) {
    ctx.font = captionFont(opts, creditSize);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.textBaseline = 'bottom';
    ctx.fillText(shot.painting.museum, cx, safe.y + safe.h);
  }

  ctx.restore();
}

/* ── crop editing ───────────────────────────────────────────────────────── */

/**
 * How the whole painting is laid into the frame while a crop is being adjusted.
 * Shared by the drawing code and by the pointer maths, so a drag lands exactly
 * where the cursor is.
 */
export function paintingFit(img, CW, CH) {
  const scale = Math.min(CW / img.naturalWidth, CH / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  return { x: (CW - w) / 2, y: (CH - h) / 2, w, h, scale };
}

/** Canvas pixels → fractions of the painting. */
export function toPaintingSpace(point, fit) {
  return {
    x: clamp01((point.x - fit.x) / fit.w),
    y: clamp01((point.y - fit.y) / fit.h),
  };
}

/**
 * The whole painting, dimmed outside the crop, with the 9:16 frame the camera
 * will actually see drawn inside it — so what you drag is what you get.
 */
export function drawCropEditor(ctx, img, focus, opts) {
  const CW = opts.width;
  const CH = opts.height;
  const fit = paintingFit(img, CW, CH);

  ctx.save();
  ctx.fillStyle = '#0b0b0d';
  ctx.fillRect(0, 0, CW, CH);
  ctx.drawImage(img, fit.x, fit.y, fit.w, fit.h);

  const box = {
    x: fit.x + focus.x * fit.w,
    y: fit.y + focus.y * fit.h,
    w: focus.w * fit.w,
    h: focus.h * fit.h,
  };

  ctx.fillStyle = 'rgba(8,8,10,0.62)';
  ctx.beginPath();
  ctx.rect(0, 0, CW, CH);
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.fill('evenodd');

  // What the shot will really frame, once the crop is grown to 9:16.
  const framed = frameRect(focus, img.naturalWidth, img.naturalHeight, CW / CH);
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.setLineDash([6, 5]);
  ctx.lineWidth = 1.5;
  ctx.strokeRect(
    fit.x + (framed.x / img.naturalWidth) * fit.w,
    fit.y + (framed.y / img.naturalHeight) * fit.h,
    (framed.w / img.naturalWidth) * fit.w,
    (framed.h / img.naturalHeight) * fit.h,
  );

  ctx.setLineDash([]);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2.5;
  ctx.strokeRect(box.x, box.y, box.w, box.h);

  ctx.restore();
}

/**
 * The title-safe rectangle, drawn over the preview only — never into a render.
 * Everything outside it is where the app's own controls land.
 */
export function drawSafeZone(ctx, opts) {
  const CW = opts.width;
  const CH = opts.height;
  const safe = safeArea(CW, CH);

  ctx.save();
  ctx.fillStyle = 'rgba(240,60,80,0.16)';
  ctx.beginPath();
  ctx.rect(0, 0, CW, CH);
  ctx.rect(safe.x, safe.y, safe.w, safe.h);
  ctx.fill('evenodd');

  ctx.strokeStyle = 'rgba(255,230,60,0.9)';
  ctx.lineWidth = Math.max(1, CH / 640);
  ctx.setLineDash([10, 7]);
  ctx.strokeRect(safe.x, safe.y, safe.w, safe.h);
  ctx.restore();
}
