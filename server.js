import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MODEL,
  buildEditEndpoint,
  buildEndpoint,
  buildUpstreamBody,
  detectImageType,
  isValidBase64,
  stripDataUrlPrefix,
} from './public/lib.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_EDIT_BODY_BYTES = 30 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 180_000;
const MAX_IMAGES = 4;
const MAX_FETCH_IMAGE_BYTES = 50 * 1024 * 1024;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data: blob: https:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

// Addresses an upstream URL must never resolve to (loopback, private, link-local
// incl. cloud metadata, CGNAT, multicast, reserved). IPv4-mapped IPv6 addresses
// are matched against the IPv4 rules by net.BlockList.
const BLOCKED_ADDRESSES = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) BLOCKED_ADDRESSES.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 96], // unspecified, loopback and deprecated IPv4-compatible
  ['64:ff9b::', 96], // NAT64 can embed any IPv4 address
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
]) BLOCKED_ADDRESSES.addSubnet(network, prefix, 'ipv6');

export function isBlockedAddress(address) {
  const bare = String(address).split('%')[0];
  const family = net.isIP(bare);
  if (family === 0) return true;
  try {
    return BLOCKED_ADDRESSES.check(bare, family === 4 ? 'ipv4' : 'ipv6');
  } catch {
    return true;
  }
}

class UpstreamBlockedError extends Error {}
class ImageTooLargeError extends Error {}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const sendError = (res, status, message) => sendJson(res, status, { error: { message } });

class BodyTooLargeError extends Error {}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    req.on('error', (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

// Error text is built from the failure, never from the request: URLs (which may
// carry credentials) and the API key are redacted before anything reaches a client.
function errorReason(err, secrets = []) {
  const cause = err && err.cause;
  const parts = [err && err.message, cause && cause.code, cause && cause.message].filter(Boolean);
  let text = [...new Set(parts)].join(': ');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret !== '') text = text.split(secret).join('[đã ẩn]');
  }
  text = text.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]');
  return text || 'Không thể kết nối tới máy chủ';
}

function isHttpUrl(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function createServer({
  fetchImpl = fetch,
  allowPrivateUpstream = false,
  lookup = (host) => dns.lookup(host, { all: true }),
  maxImageBytes = MAX_FETCH_IMAGE_BYTES,
} = {}) {
  // Rejects URLs that could turn this server into a proxy for internal networks.
  async function assertPublicUpstream(rawUrl) {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new UpstreamBlockedError('Địa chỉ upstream không hợp lệ');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new UpstreamBlockedError('Địa chỉ upstream phải bắt đầu bằng http:// hoặc https://');
    }
    if (parsed.username || parsed.password) {
      throw new UpstreamBlockedError('Địa chỉ upstream không được chứa user:password');
    }
    if (allowPrivateUpstream) return;
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    let addresses;
    if (net.isIP(host)) {
      addresses = [host];
    } else {
      try {
        addresses = (await lookup(host)).map((entry) => entry.address);
      } catch {
        throw new UpstreamBlockedError('Không phân giải được tên miền của địa chỉ upstream');
      }
    }
    if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
      throw new UpstreamBlockedError('Địa chỉ upstream trỏ tới mạng nội bộ hoặc không được phép');
    }
  }

  // Reads and parses a JSON object body; on failure answers the client and returns null.
  async function readJsonObject(req, res, limit, limitLabel) {
    let raw;
    try {
      raw = await readBody(req, limit);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        res.setHeader('Connection', 'close');
        sendError(res, 413, 'Request body vượt quá ' + limitLabel);
      } else {
        sendError(res, 400, 'Không đọc được request body');
      }
      return null;
    }
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      sendError(res, 400, 'Request body không phải JSON hợp lệ');
      return null;
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      sendError(res, 400, 'Request body phải là một JSON object');
      return null;
    }
    return input;
  }

  // Answers the client with 400 and returns false when the endpoint is not allowed.
  async function checkUpstream(res, endpoint) {
    if (!isHttpUrl(endpoint)) {
      sendError(res, 400, 'Base URL phải bắt đầu bằng http:// hoặc https://');
      return false;
    }
    try {
      await assertPublicUpstream(endpoint);
    } catch (err) {
      if (err instanceof UpstreamBlockedError) {
        sendError(res, 400, err.message);
        return false;
      }
      throw err;
    }
    return true;
  }

  // One upstream POST. Redirects are never followed; the outcome is data, never a throw.
  async function postUpstream(endpoint, apiKey, { headers = {}, body }) {
    try {
      const upstream = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey.trim()}`, ...headers },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        return { networkError: new Error('Upstream trả về chuyển hướng (HTTP ' + upstream.status + '), không được theo dõi') };
      }
      return {
        status: upstream.status,
        type: upstream.headers.get('content-type') || 'application/octet-stream',
        buffer: Buffer.from(await upstream.arrayBuffer()),
      };
    } catch (err) {
      return { networkError: err };
    }
  }

  const sendRaw = (res, r) => {
    res.writeHead(r.status, { 'Content-Type': r.type, 'Content-Length': r.buffer.length });
    res.end(r.buffer);
  };

  async function handleGenerate(req, res) {
    const input = await readJsonObject(req, res, MAX_BODY_BYTES, '1 MB');
    if (!input) return;
    const { baseUrl, apiKey, model, prompt, size, n } = input;
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      return sendError(res, 400, 'Thiếu apiKey');
    }
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      return sendError(res, 400, 'Thiếu prompt');
    }

    const endpoint = buildEndpoint(baseUrl);
    if (!(await checkUpstream(res, endpoint))) return;

    // Upstream rejects any n > 1 with 400, so fan out n single-image requests.
    const count = Number.isInteger(n) && n > 1 ? Math.min(n, MAX_IMAGES) : 1;
    const body = JSON.stringify(buildUpstreamBody({ model, prompt, size, n: 1 }));
    const callUpstream = () =>
      postUpstream(endpoint, apiKey, { headers: { 'Content-Type': 'application/json' }, body });
    const results = await Promise.all(Array.from({ length: count }, callUpstream));
    return respondFanOut(res, results, apiKey, endpoint);
  }

  // Answers with one result verbatim, or merges several 200 responses in order.
  function respondFanOut(res, results, apiKey, endpoint) {
    const failed = results.find((r) => r.networkError);
    if (failed) return sendError(res, 502, errorReason(failed.networkError, [apiKey.trim(), endpoint]));

    if (results.length === 1) return sendRaw(res, results[0]);

    // First non-success (or unmergeable) response is passed through verbatim.
    const merged = [];
    let created;
    for (const r of results) {
      let json;
      if (r.status === 200) {
        try {
          json = JSON.parse(r.buffer.toString('utf8'));
        } catch {
          json = null;
        }
      }
      if (!json || !Array.isArray(json.data)) return sendRaw(res, r);
      created ??= json.created;
      merged.push(...json.data);
    }
    const payload = { data: merged };
    if (created !== undefined) payload.created = created;
    return sendJson(res, 200, payload);
  }

  async function handleEdit(req, res) {
    const input = await readJsonObject(req, res, MAX_EDIT_BODY_BYTES, '30 MB');
    if (!input) return;
    const { baseUrl, apiKey, model, prompt, size, n } = input;
    if (typeof apiKey !== 'string' || apiKey.trim() === '') return sendError(res, 400, 'Thiếu apiKey');
    if (typeof prompt !== 'string' || prompt.trim() === '') return sendError(res, 400, 'Thiếu prompt');

    // `images` (1..4 base64 strings) or the single-image `image` field.
    const rawImages = Array.isArray(input.images) ? input.images : input.image !== undefined ? [input.image] : [];
    if (rawImages.length === 0) return sendError(res, 400, 'Thiếu ảnh nguồn (images)');
    if (rawImages.length > MAX_IMAGES) return sendError(res, 400, `Tối đa ${MAX_IMAGES} ảnh mỗi yêu cầu`);
    const parts = [];
    for (const [i, value] of rawImages.entries()) {
      if (typeof value !== 'string' || value.trim() === '') return sendError(res, 400, `Ảnh ${i + 1} bị thiếu`);
      const payload = stripDataUrlPrefix(value);
      if (!isValidBase64(payload)) return sendError(res, 400, `Ảnh ${i + 1} không phải base64 hợp lệ`);
      const bytes = Buffer.from(payload, 'base64');
      const mime = detectImageType(bytes);
      if (!mime) return sendError(res, 400, `Ảnh ${i + 1} phải là PNG, JPEG hoặc WEBP`);
      parts.push({ bytes, mime, name: `image${i + 1}.${mime.split('/')[1].replace('jpeg', 'jpg')}` });
    }

    const endpoint = buildEditEndpoint(baseUrl);
    if (!(await checkUpstream(res, endpoint))) return;

    // Upstream only supports n = 1 per edit call, so fan out n single-image requests (`n` is never forwarded).
    const count = Number.isInteger(n) && n > 1 ? Math.min(n, MAX_IMAGES) : 1;
    const modelName = (typeof model === 'string' ? model.trim() : '') || DEFAULT_MODEL;
    const callUpstream = () => {
      const form = new FormData();
      form.append('model', modelName);
      form.append('prompt', prompt);
      if (typeof size === 'string' && size.trim() !== '') form.append('size', size.trim());
      for (const part of parts) form.append('image[]', new Blob([part.bytes], { type: part.mime }), part.name);
      return postUpstream(endpoint, apiKey, { body: form });
    };
    const results = await Promise.all(Array.from({ length: count }, callUpstream));
    return respondFanOut(res, results, apiKey, endpoint);
  }

  async function handleFetchImage(req, res, url) {
    const target = url.searchParams.get('url');
    if (!target || !isHttpUrl(target)) {
      return sendError(res, 400, 'Tham số url phải là địa chỉ http hoặc https hợp lệ');
    }
    try {
      await assertPublicUpstream(target);
    } catch (err) {
      if (err instanceof UpstreamBlockedError) return sendError(res, 400, err.message);
      throw err;
    }
    let upstream;
    try {
      upstream = await fetchImpl(target, { redirect: 'manual', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    } catch (err) {
      return sendError(res, 502, errorReason(err, [target]));
    }
    if (upstream.status >= 300 && upstream.status < 400) {
      upstream.body?.cancel?.().catch(() => {});
      return sendError(res, 502, 'Máy chủ ảnh trả về chuyển hướng (HTTP ' + upstream.status + '), không được theo dõi');
    }
    const declared = Number(upstream.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxImageBytes) {
      upstream.body?.cancel?.().catch(() => {});
      return sendError(res, 413, 'Ảnh vượt quá giới hạn ' + Math.round(maxImageBytes / 1024 / 1024) + ' MB');
    }
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    });
    if (!upstream.body) return res.end();
    let received = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > maxImageBytes) return callback(new ImageTooLargeError());
        callback(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(upstream.body), limiter, res);
    } catch {
      res.destroy();
    }
  }

  function handleStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return sendError(res, 405, 'Method not allowed');
    }
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return sendError(res, 400, 'Đường dẫn không hợp lệ');
    }
    if (pathname.includes('\0')) return sendError(res, 400, 'Đường dẫn không hợp lệ');
    if (pathname.endsWith('/')) pathname += 'index.html';

    const filePath = path.resolve(PUBLIC_DIR, '.' + pathname);
    if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
      return sendError(res, 403, 'Forbidden');
    }
    fs.stat(filePath, (statErr, stat) => {
      if (statErr || !stat.isFile()) return sendError(res, 404, 'Not found');
      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(filePath);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    });
  }

  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    if (url.pathname.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    const route = async () => {
      if (url.pathname === '/api/generate') {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST');
          return sendError(res, 405, 'Method not allowed');
        }
        return handleGenerate(req, res);
      }
      if (url.pathname === '/api/edit') {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST');
          return sendError(res, 405, 'Method not allowed');
        }
        return handleEdit(req, res);
      }
      if (url.pathname === '/api/fetch-image') {
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET');
          return sendError(res, 405, 'Method not allowed');
        }
        return handleFetchImage(req, res, url);
      }
      return handleStatic(req, res, url);
    };
    route().catch(() => {
      if (!res.headersSent) sendError(res, 500, 'Lỗi máy chủ cục bộ');
      else res.destroy();
    });
  });
}

export function resolveListenOptions(env = process.env) {
  return { host: env.HOST || '127.0.0.1', port: Number(env.PORT) || 5173 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { host, port } = resolveListenOptions();
  createServer().listen(port, host, () => {
    console.log(`Viber Image Studio: http://${host}:${port}`);
  });
}
