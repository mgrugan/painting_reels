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
 */
export function toModelImage(img, maxEdge = 1000, quality = 0.85) {
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);

  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), mediaType: 'image/jpeg', w, h };
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}
