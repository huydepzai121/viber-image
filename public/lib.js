// Pure logic shared by the browser UI, the local server and the tests.
// No DOM or Node-only APIs may be used here.

export const DEFAULT_BASE_URL = 'https://bedrock.viber.vn';
export const DEFAULT_MODEL = 'gpt-image-2-5';
export const ENDPOINT_PATH = '/v1/images/generations';
export const SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto'];
export const COUNTS = [1, 2, 3, 4];

const SUFFIX_RE = /\/v1\/images\/generations$/i;

/** Trim, drop trailing slashes and a trailing /v1/images/generations; empty -> default. */
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
      let payload = b64.trim();
      if (payload.startsWith('data:')) {
        const comma = payload.indexOf(',');
        payload = comma === -1 ? '' : payload.slice(comma + 1);
      }
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
  return {
    baseUrl: str(src.baseUrl, DEFAULT_BASE_URL),
    apiKey: str(src.apiKey, ''),
    model: str(src.model, DEFAULT_MODEL),
    prompt: str(src.prompt, ''),
    size: SIZES.includes(src.size) ? src.size : SIZES[0],
    n: Number.isInteger(src.n) && src.n >= 1 && src.n <= 4 ? src.n : 1,
  };
}

/** The JSON body sent upstream. */
export function buildUpstreamBody({ model, prompt, size, n }) {
  return { model: (model ?? '').trim() || DEFAULT_MODEL, prompt, size, n };
}
