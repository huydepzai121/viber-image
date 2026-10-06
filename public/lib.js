// Pure logic shared by the browser UI, the local server and the tests.
// No DOM or Node-only APIs may be used here.

export const DEFAULT_BASE_URL = 'https://bedrock.viber.vn';
export const DEFAULT_MODEL = 'gpt-image-2-5';
export const ENDPOINT_PATH = '/v1/images/generations';
export const EDIT_ENDPOINT_PATH = '/v1/images/edits';
export const EXPECTED_DURATION_MS = 60_000;
const PROGRESS_CEILING = 95;
export const SIZES =['1024x1024', '1536x1024', '1024x1536', 'auto'];
export const COUNTS = [1, 2, 3, 4];

const SUFFIX_RE = /\/v1\/images\/(?:generations|edits)$/i;

/** Trim, drop trailing slashes and a trailing /v1/images/generations or /edits; empty -> default. */
export function normalizeBaseUrl(input) {
  let value = typeof input === 'string' ? input.trim() : '';
  value = value.replace(/\/+$/, '');
  value = value.replace(SUFFIX_RE, '');
  value = value.replace(/\/+$/, '');
  return value === '' ? DEFAULT_BASE_URL : value;
}

export function buildEndpoint(input) {
  return normalizeBaseUrl(input) + ENDPOINT_PATH;
}

export function buildEditEndpoint(input) {
  return normalizeBaseUrl(input) + EDIT_ENDPOINT_PATH;
}

/** Remove a leading `data:...,` prefix and surrounding whitespace; '' when a data: value has no payload. */
export function stripDataUrlPrefix(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text.startsWith('data:')) return text;
  const comma = text.indexOf(',');
  return comma === -1 ? '' : text.slice(comma + 1).trim();
}

/** True when `value` (after removing whitespace) is a non-empty, correctly padded standard base64 string. */
export function isValidBase64(value) {
  if (typeof value !== 'string') return false;
  const compact = value.replace(/\s+/g, '');
  return compact !== '' && compact.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(compact);
}

/** Image MIME type from magic bytes (PNG, JPEG, WEBP) or null. `bytes` is any indexable byte sequence. */
export function detectImageType(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const at = (i) => bytes[i];
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => at(i) === b)) return 'image/png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  const ascii = (start, text) => [...text].every((ch, i) => at(start + i) === ch.charCodeAt(0));
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  return null;
}

/** Estimated progress (integer 0..95): eases toward 95 over `expectedMs`, monotonic, never 100. */
export function estimateProgress(elapsedMs, expectedMs = EXPECTED_DURATION_MS) {
  const elapsed = Number(elapsedMs);
  const expected = Number(expectedMs);
  if (!(elapsed > 0) || !(expected > 0)) return 0;
  const eased = PROGRESS_CEILING * (1 - Math.exp((-3 * elapsed) / expected));
  return Math.min(PROGRESS_CEILING, Math.floor(eased));
}

/** HH:MM:SS in local time. */
export function formatClock(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Collect usable images from an images-generation response object.
 * Returns [{ kind: 'b64' | 'url', src }]. For b64 the `src` is raw base64
 * (any `data:...,` prefix removed).
 */
export function extractImages(json) {
  const data = json && typeof json === 'object' ? json.data : undefined;
  if (!Array.isArray(data)) return [];
  const images = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const b64 = item.b64_json;
    if (typeof b64 === 'string' && b64.trim() !== '') {
      const payload = stripDataUrlPrefix(b64);
      if (payload !== '') {
        images.push({ kind: 'b64', src: payload });
        continue;
      }
    }
    if (typeof item.url === 'string' && item.url.trim() !== '') {
      images.push({ kind: 'url', src: item.url.trim() });
    }
  }
  return images;
}

/** Name of the response field(s) the images came from: 'b64_json', 'url' or 'b64_json + url'. */
export function describeSource(images) {
  const hasB64 = images.some((i) => i.kind === 'b64');
  const hasUrl = images.some((i) => i.kind === 'url');
  if (hasB64 && hasUrl) return 'b64_json + url';
  return hasUrl ? 'url' : 'b64_json';
}

const pad = (value, length = 2) => String(value).padStart(length, '0');

/** img_YYYYMMDD_HHMMSS.png in local time; `_<index+1>` suffix when total > 1. `index` is zero-based. */
export function makeFilename(date, index = 0, total = 1) {
  const stamp =
    String(date.getFullYear()).padStart(4, '0') +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    '_' +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds());
  return total > 1 ? `img_${stamp}_${index + 1}.png` : `img_${stamp}.png`;
}

/** Pretty-print JSON with 2 spaces, otherwise return the raw text. */
export function formatErrorBody(text) {
  const raw = typeof text === 'string' ? text : String(text ?? '');
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** Elapsed milliseconds -> seconds with one decimal and a comma separator ("8,4"). */
export function formatElapsed(ms) {
  return (Math.max(0, ms) / 1000).toFixed(1).replace('.', ',');
}

/** Validate untrusted stored settings field by field, falling back to defaults. */
export function sanitizeSettings(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const str = (value, fallback) => (typeof value === 'string' ? value : fallback);
  const rememberKey = src.rememberKey === true;
  return {
    baseUrl: str(src.baseUrl, DEFAULT_BASE_URL),
    // A key is only ever restored when the visitor opted in to remembering it.
    apiKey: rememberKey ? str(src.apiKey, '') : '',
    rememberKey,
    model: str(src.model, DEFAULT_MODEL),
    prompt: str(src.prompt, ''),
    size: SIZES.includes(src.size) ? src.size : SIZES[0],
    n: Number.isInteger(src.n) && src.n >= 1 && src.n <= 4 ? src.n : 1,
  };
}

/** Settings as written to localStorage: the API key is dropped unless the visitor opted in. */
export function settingsForStorage(settings) {
  return settings.rememberKey ? { ...settings } : { ...settings, apiKey: '' };
}

/** The JSON body sent upstream. */
export function buildUpstreamBody({ model, prompt, size, n }) {
  return { model: (model ?? '').trim() || DEFAULT_MODEL, prompt, size, n };
}

export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 30 * 1024 * 1024;
export const ATTACHMENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
// Images travel base64-encoded (x 4/3) inside a JSON body capped at MAX_REQUEST_BYTES; leave 1 MB for the other fields.
export const MAX_TOTAL_IMAGE_BYTES = Math.floor(((MAX_REQUEST_BYTES - 1024 * 1024) * 3) / 4);

/** Expected duration (ms): 60 s without images, 70 s for up to 2 images, +15 s for each further image. */
export function expectedDuration(imageCount = 0) {
  const count = Number.isFinite(imageCount) ? Math.max(0, Math.floor(imageCount)) : 0;
  if (count === 0) return EXPECTED_DURATION_MS;
  return 70_000 + 15_000 * Math.max(0, count - 2);
}

/**
 * Check whether `file` ({ type, size, name }) may be attached given what is already attached
 * (`count` images, `totalBytes` bytes). Returns a Vietnamese error message or null.
 */
export function checkAttachment({ count, totalBytes }, file) {
  const label = file && file.name ? ` "${file.name}"` : '';
  if (!file || !ATTACHMENT_TYPES.includes(file.type)) return `Ảnh${label} phải là PNG, JPEG hoặc WEBP.`;
  if (count >= MAX_ATTACHMENTS) return `Tối đa ${MAX_ATTACHMENTS} ảnh mỗi yêu cầu.`;
  if (file.size > MAX_ATTACHMENT_BYTES) return `Ảnh${label} vượt quá ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`;
  if (totalBytes + file.size > MAX_TOTAL_IMAGE_BYTES) {
    return `Tổng dung lượng ảnh vượt giới hạn (~${Math.floor(MAX_TOTAL_IMAGE_BYTES / 1024 / 1024)} MB để vừa request 30 MB).`;
  }
  return null;
}
