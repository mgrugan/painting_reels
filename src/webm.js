/**
 * MediaRecorder writes WebM without a Segment Duration, because it does not know
 * how long the recording will be until it ends. Players cope by scanning the
 * whole file; editors and upload forms often just report the length as unknown.
 *
 * Since we do know the duration, we splice a Duration element into the Info
 * element after the fact. Chrome and Firefox write no SeekHead and no Cues, so
 * nothing in the file refers to a byte offset and growing Info by a few bytes is
 * safe. If anything looks unfamiliar we hand the original file back untouched.
 */

const INFO_ID = [0x15, 0x49, 0xa9, 0x66];
const TIMECODE_SCALE_ID = [0x2a, 0xd7, 0xb1];
const DURATION_ID = [0x44, 0x89];
const SEEK_HEAD_ID = [0x11, 0x4d, 0x9b, 0x74];
const CUES_ID = [0x1c, 0x53, 0xbb, 0x6b];
const HEADER_SCAN = 4096;

export async function patchWebmDuration(blob, seconds) {
  try {
    const head = new Uint8Array(await blob.slice(0, HEADER_SCAN).arrayBuffer());

    // Byte offsets would shift under us if either of these were present.
    if (indexOf(head, SEEK_HEAD_ID) !== -1 || indexOf(head, CUES_ID) !== -1) return blob;

    const infoAt = indexOf(head, INFO_ID);
    if (infoAt === -1) return blob;

    const size = readVint(head, infoAt + INFO_ID.length);
    if (!size) return blob;

    const contentAt = size.end;
    const contentEnd = contentAt + size.value;
    if (contentEnd > head.length) return blob;

    const content = head.subarray(contentAt, contentEnd);
    if (indexOf(content, DURATION_ID) !== -1) return blob; // already has one

    const scale = readTimecodeScale(content) ?? 1_000_000;
    const ticks = (seconds * 1e9) / scale;

    const duration = new Uint8Array(11);
    duration.set(DURATION_ID, 0);
    duration[2] = 0x88; // an 8-byte payload
    new DataView(duration.buffer).setFloat64(3, ticks, false);

    const newContent = new Uint8Array(content.length + duration.length);
    newContent.set(content, 0);
    newContent.set(duration, content.length);

    return new Blob(
      [
        head.subarray(0, infoAt + INFO_ID.length),
        vint8(newContent.length),
        newContent,
        blob.slice(contentEnd),
      ],
      { type: blob.type },
    );
  } catch {
    return blob;
  }
}

/** EBML element sizes are variable-length integers; we only need to read them. */
function readVint(bytes, at) {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  let length = 1;
  for (let mask = 0x80; mask && !(first & mask); mask >>= 1) length += 1;
  if (at + length > bytes.length) return null;

  let value = first & (0xff >> length);
  let unknown = value === (0xff >> length);
  for (let i = 1; i < length; i += 1) {
    value = value * 256 + bytes[at + i];
    unknown = unknown && bytes[at + i] === 0xff;
  }
  return unknown ? null : { value, end: at + length };
}

/** Always writes the 8-byte form, which is valid for any size we produce. */
function vint8(value) {
  const out = new Uint8Array(8);
  out[0] = 0x01;
  let rest = value;
  for (let i = 7; i >= 1; i -= 1) {
    out[i] = rest & 0xff;
    rest = Math.floor(rest / 256);
  }
  return out;
}

function readTimecodeScale(content) {
  const at = indexOf(content, TIMECODE_SCALE_ID);
  if (at === -1) return null;
  const size = readVint(content, at + TIMECODE_SCALE_ID.length);
  if (!size || size.value < 1 || size.value > 8) return null;
  let value = 0;
  for (let i = 0; i < size.value; i += 1) value = value * 256 + content[size.end + i];
  return value || null;
}

function indexOf(haystack, needle) {
  outer: for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
