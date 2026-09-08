/**
 * Loading paintings, and preparing the small copy that goes to the model.
 *
 * Wikimedia serves `Access-Control-Allow-Origin: *` on upload.wikimedia.org, so
 * these images can be drawn to a canvas and read back without tainting it. Files
 * the user adds themselves are read as data URLs and are never uploaded anywhere
 * except, in downscaled form, to the Messages API.
 */

const cache = new Map();

export async function loadImage(url) {
  if (cache.has(url)) return cache.get(url);
  const promise = new Promise((resolve, reject) => {
    const img = new Image();
    if (!url.startsWith('data:') && !url.startsWith('blob:')) img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error('That image could not be loaded. It may be offline or blocked.'));
    img.src = url;
  });
  cache.set(url, promise);
  promise.catch(() => cache.delete(url));
  return promise;
}

/**
 * A JPEG small enough to be cheap as model input but large enough to read
 * details in. ~1000px on the long edge is around 1.1k tokens.
 *
 * With `grid`, a labelled 0.0-1.0 coordinate grid is drawn over it. Models are
 * far better at "the glove is at x 0.2, y 0.85" when they can read the number
 * off a ruler than when they have to estimate a fraction of an unmarked
 * rectangle, and the crops are only as good as those numbers.
 */
export function toModelImage(img, { maxEdge = 1000, quality = 0.85, grid = true } = {}) {
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  if (grid) drawCoordinateGrid(ctx, w, h);

  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), mediaType: 'image/jpeg', w, h };
}

/** Thin ticks every 0.1 with the numbers written along the top and left edges. */
function drawCoordinateGrid(ctx, w, h, step = 0.1) {
  const label = Math.max(11, Math.round(Math.min(w, h) * 0.022));

  ctx.save();
  ctx.lineWidth = 1;
  ctx.font = `600 ${label}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.textBaseline = 'top';

  for (let i = 1; i < Math.round(1 / step); i += 1) {
    const f = i * step;
    const x = Math.round(f * w) + 0.5;
    const y = Math.round(f * h) + 0.5;

    // Two passes so the lines read on both light and dark paint.
    for (const [colour, offset] of [
      ['rgba(0,0,0,0.30)', 1],
      ['rgba(255,255,255,0.45)', 0],
    ]) {
      ctx.strokeStyle = colour;
      ctx.beginPath();
      ctx.moveTo(x + offset, 0);
      ctx.lineTo(x + offset, h);
      ctx.moveTo(0, y + offset);
      ctx.lineTo(w, y + offset);
      ctx.stroke();
    }

    const text = f.toFixed(1);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.strokeText(text, x, 3);
    ctx.fillText(text, x, 3);
    ctx.textAlign = 'left';
    ctx.strokeText(text, 4, y + 3);
    ctx.fillText(text, 4, y + 3);
    ctx.lineWidth = 1;
  }

  ctx.restore();
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}
