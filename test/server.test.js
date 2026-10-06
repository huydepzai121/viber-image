import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer, resolveListenOptions } from '../server.js';

let upstream;
let app;
let upstreamUrl;
let appUrl;
let last; // last request seen by the mock upstream
let calls = []; // every request seen by the mock upstream
let replyFn; // optional (callIndex) => reply, overrides reply
let reply; // { status, headers, body } for the next upstream reply

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      last = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      calls.push(last);
      const r = (replyFn && replyFn(calls.length - 1)) || reply || { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{}' };
      res.writeHead(r.status, r.headers);
      res.end(r.body);
    });
  });
  upstreamUrl = await listen(upstream);
  app = createServer();
  appUrl = await listen(app);
});

after(() => {
  app.close();
  upstream.close();
  app.closeAllConnections?.();
  upstream.closeAllConnections?.();
});

const generate = (payload, raw) =>
  fetch(`${appUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ?? JSON.stringify(payload),
  });

const valid = { apiKey: 'sk-test', model: 'gpt-image-2-5', prompt: 'cat', size: '1536x1024', n: 2 };

test('listen options default to 127.0.0.1:5173 and honour HOST/PORT', () => {
  assert.deepEqual(resolveListenOptions({}), { host: '127.0.0.1', port: 5173 });
  assert.deepEqual(resolveListenOptions({ HOST: '0.0.0.0', PORT: '8080' }), { host: '0.0.0.0', port: 8080 });
});

test('generate forwards exact body and headers to the normalized endpoint', async () => {
  reply = { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{"data":[{"b64_json":"AAAA"}]}' };
  const res = await generate({ ...valid, n: 1, baseUrl: ` ${upstreamUrl}/v1/images/generations/ ` });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), reply.body);
  assert.equal(last.method, 'POST');
  assert.equal(last.url, '/v1/images/generations');
  assert.equal(last.headers.authorization, 'Bearer sk-test');
  assert.equal(last.headers['content-type'], 'application/json');
  assert.equal(last.body, '{"model":"gpt-image-2-5","prompt":"cat","size":"1536x1024","n":1}');
});

test('upstream status, content type and body pass through (401, 429, 500)', async () => {
  for (const [status, type, body] of [
    [401, 'application/json', '{"error":{"message":"Incorrect API key provided."}}'],
    [429, 'text/plain', 'slow down'],
    [500, 'text/html', '<h1>oops</h1>'],
  ]) {
    reply = { status, headers: { 'Content-Type': type }, body };
    const res = await generate({ ...valid, baseUrl: upstreamUrl });
    assert.equal(res.status, status);
    assert.equal(res.headers.get('content-type'), type);
    assert.equal(await res.text(), body);
  }
});

test('unreachable upstream gives 502 with an error message', async () => {
  const dead = http.createServer();
  const deadUrl = await listen(dead);
  await new Promise((resolve) => dead.close(resolve));
  const res = await generate({ ...valid, baseUrl: deadUrl });
  assert.equal(res.status, 502);
  const json = await res.json();
  assert.equal(typeof json.error.message, 'string');
  assert.ok(json.error.message.length > 0);
});

test('invalid input gives 400', async () => {
  assert.equal((await generate(null, 'not json')).status, 400);
  assert.equal((await generate(null, '[1]')).status, 400);
  assert.equal((await generate({ ...valid, apiKey: ' ' })).status, 400);
  assert.equal((await generate({ ...valid, prompt: '' })).status, 400);
  assert.equal((await generate({ ...valid, baseUrl: 'ftp://example.com' })).status, 400);
});

test('bodies over 1 MB are rejected with 413', async () => {
  let status;
  try {
    status = (await generate({ ...valid, prompt: 'x'.repeat(1024 * 1024 + 10) })).status;
  } catch {
    status = 413; // server may close the socket while the client is still sending
  }
  assert.equal(status, 413);
});

test('GET /api/generate is not allowed', async () => {
  assert.equal((await fetch(`${appUrl}/api/generate`)).status, 405);
});

test('fetch-image streams bytes with upstream content type', async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  reply = { status: 200, headers: { 'Content-Type': 'image/png' }, body: bytes };
  const res = await fetch(`${appUrl}/api/fetch-image?url=${encodeURIComponent(upstreamUrl + '/img.png')}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
  assert.equal(last.url, '/img.png');
});

test('fetch-image passes upstream error status through', async () => {
  reply = { status: 404, headers: { 'Content-Type': 'text/plain' }, body: 'nope' };
  const res = await fetch(`${appUrl}/api/fetch-image?url=${encodeURIComponent(upstreamUrl + '/missing.png')}`);
  assert.equal(res.status, 404);
  assert.equal(await res.text(), 'nope');
});

test('fetch-image rejects non-http(s) and missing urls with 400', async () => {
  for (const q of ['url=file:///etc/passwd', 'url=ftp://x/y', 'url=garbage', '']) {
    assert.equal((await fetch(`${appUrl}/api/fetch-image?${q}`)).status, 400, q);
  }
});

test('static: serves index and lib.js with correct content types', async () => {
  const index = await fetch(`${appUrl}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  const lib = await fetch(`${appUrl}/lib.js`);
  assert.equal(lib.status, 200);
  assert.match(lib.headers.get('content-type'), /text\/javascript/);
  assert.match(await lib.text(), /normalizeBaseUrl/);
  assert.match((await fetch(`${appUrl}/styles.css`)).headers.get('content-type'), /text\/css/);
});

test('static: path traversal and missing files are refused', async () => {
  const raw = (path) =>
    new Promise((resolve, reject) => {
      const { port } = app.address();
      const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end();
    });
  assert.equal(await raw('/../server.js'), 404); // URL parser collapses it inside public/
  assert.equal(await raw('/%2e%2e/server.js'), 404);
  assert.equal(await raw('/..%2fpackage.json'), 403);
  assert.equal(await raw('/nope.txt'), 404);
});

const json200 = (obj) => ({ status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

test('n=3 fans out to 3 upstream requests with n:1 and merges the items', async () => {
  calls = [];
  reply = null;
  replyFn = (i) => json200({ created: 100 + i, data: [{ b64_json: `IMG${i}` }] });
  try {
    const res = await generate({ ...valid, n: 3, baseUrl: upstreamUrl });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^application\/json/);
    const json = await res.json();
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(call.body, '{"model":"gpt-image-2-5","prompt":"cat","size":"1536x1024","n":1}');
      assert.equal(call.headers.authorization, 'Bearer sk-test');
    }
    assert.equal(json.data.length, 3);
    assert.deepEqual(json.data.map((d) => d.b64_json).sort(), ['IMG0', 'IMG1', 'IMG2']);
    assert.equal(typeof json.created, 'number');
  } finally {
    replyFn = undefined;
  }
});

test('n=1 sends a single upstream request and passes the body through verbatim', async () => {
  calls = [];
  reply = json200({ created: 1, data: [{ url: 'https://x/y.png' }], extra: 'kept' });
  const res = await generate({ ...valid, n: 1, baseUrl: upstreamUrl });
  assert.equal(calls.length, 1);
  assert.equal(await res.text(), reply.body);
});

test('n>1 with one failing upstream request passes that failure through verbatim', async () => {
  calls = [];
  reply = null;
  replyFn = (i) =>
    i === 1
      ? { status: 429, headers: { 'Content-Type': 'text/plain' }, body: 'slow down' }
      : json200({ created: 1, data: [{ b64_json: `IMG${i}` }] });
  try {
    const res = await generate({ ...valid, n: 3, baseUrl: upstreamUrl });
    assert.equal(calls.length, 3);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('content-type'), 'text/plain');
    assert.equal(await res.text(), 'slow down');
  } finally {
    replyFn = undefined;
  }
});

test('n>1 with an unreachable upstream gives 502', async () => {
  const dead = http.createServer();
  const deadUrl = await listen(dead);
  await new Promise((resolve) => dead.close(resolve));
  const res = await generate({ ...valid, n: 2, baseUrl: deadUrl });
  assert.equal(res.status, 502);
  assert.equal(typeof (await res.json()).error.message, 'string');
});
