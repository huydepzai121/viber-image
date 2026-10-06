import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../server.js';

let upstream;
let app;
let upstreamUrl;
let appUrl;
let calls = [];
let reply;

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

const json200 = (obj) => ({ status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const last = () => calls[calls.length - 1];

before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers, raw: Buffer.concat(chunks) });
      const r = reply || json200({});
      res.writeHead(r.status, r.headers);
      res.end(r.body);
    });
  });
  upstreamUrl = await listen(upstream);
  app = createServer({ allowPrivateUpstream: true });
  appUrl = await listen(app);
});

after(() => {
  app.close();
  upstream.close();
  app.closeAllConnections?.();
  upstream.closeAllConnections?.();
});

const startServer = async (options) => {
  const server = createServer(options);
  const url = await listen(server);
  return { server, url, close: () => { server.close(); server.closeAllConnections?.(); } };
};

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-payload')]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake-jpeg-payload')]);
const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')]);
const editPayload = {
  apiKey: 'sk-test',
  model: 'gpt-image-2-5',
  prompt: 'make it blue',
  size: '1024x1024',
  image: PNG_BYTES.toString('base64'),
};

const edit = (payload, raw) =>
  fetch(`${appUrl}/api/edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ?? JSON.stringify(payload),
  });

const parseMultipart = (call) =>
  new Response(call.raw, { headers: { 'content-type': call.headers['content-type'] } }).formData();

test('edit forwards a multipart request to /v1/images/edits without n', async () => {
  calls = [];
  reply = json200({ created: 1, data: [{ b64_json: 'EDITED' }] });
  const res = await edit({ ...editPayload, baseUrl: ` ${upstreamUrl}/v1/images/generations/ ` });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(await res.text(), reply.body);
  assert.equal(calls.length, 1);
  assert.equal(last().method, 'POST');
  assert.equal(last().url, '/v1/images/edits');
  assert.equal(last().headers.authorization, 'Bearer sk-test');
  assert.match(last().headers['content-type'], /^multipart\/form-data; boundary=/);
  const form = await parseMultipart(last());
  assert.equal(form.get('model'), 'gpt-image-2-5');
  assert.equal(form.get('prompt'), 'make it blue');
  assert.equal(form.get('size'), '1024x1024');
  assert.equal(form.has('n'), false);
  const file = form.get('image[]');
  assert.equal(file.type, 'image/png');
  assert.equal(file.name, 'image1.png');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG_BYTES);
});

test('edit accepts a data: prefix and JPEG/WEBP, and defaults the model', async () => {
  reply = json200({ data: [{ b64_json: 'X' }] });
  for (const [bytes, type] of [[JPEG_BYTES, 'image/jpeg'], [WEBP_BYTES, 'image/webp']]) {
    const image = `data:${type};base64,${bytes.toString('base64')}`;
    const res = await edit({ ...editPayload, model: '  ', image, baseUrl: upstreamUrl });
    assert.equal(res.status, 200, type);
    await res.arrayBuffer();
    const form = await parseMultipart(last());
    assert.equal(form.get('model'), 'gpt-image-2-5');
    assert.equal(form.get('image[]').type, type);
    assert.deepEqual(Buffer.from(await form.get('image[]').arrayBuffer()), bytes);
  }
});

test('edit passes upstream status, content type and body through', async () => {
  reply = { status: 429, headers: { 'Content-Type': 'text/plain' }, body: 'slow down' };
  const res = await edit({ ...editPayload, baseUrl: upstreamUrl });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('content-type'), 'text/plain');
  assert.equal(await res.text(), 'slow down');
});

test('edit rejects invalid input with 400 and never calls upstream', async () => {
  calls = [];
  const base = { ...editPayload, baseUrl: upstreamUrl };
  const notImage = Buffer.from('this is plain text, not an image').toString('base64');
  const cases = {
    'not json': [null, 'nope'],
    'json array': [null, '[1]'],
    'missing apiKey': [{ ...base, apiKey: ' ' }],
    'missing prompt': [{ ...base, prompt: '  ' }],
    'prompt not a string': [{ ...base, prompt: 5 }],
    'missing image': [{ ...base, image: undefined }],
    'empty image': [{ ...base, image: '' }],
    'image not a string': [{ ...base, image: 12 }],
    'bad base64 chars': [{ ...base, image: 'not*base64!!' }],
    'bad base64 padding': [{ ...base, image: PNG_BYTES.toString('base64').slice(0, -1) }],
    'data prefix without payload': [{ ...base, image: 'data:image/png;base64,' }],
    'wrong magic bytes': [{ ...base, image: notImage }],
    'gif is rejected': [{ ...base, image: Buffer.from('GIF89a......').toString('base64') }],
    'too short': [{ ...base, image: Buffer.from([0x89, 0x50]).toString('base64') }],
    'bad base url': [{ ...base, baseUrl: 'ftp://example.com' }],
  };
  for (const [name, [payload, raw]] of Object.entries(cases)) {
    const res = await edit(payload, raw);
    assert.equal(res.status, 400, name);
    assert.equal(typeof (await res.json()).error.message, 'string', name);
  }
  assert.equal(calls.length, 0);
});

test('edit bodies over 30 MB get 413 while bodies over 1 MB are still accepted', async () => {
  let status;
  try {
    status = (await edit({ ...editPayload, baseUrl: upstreamUrl, image: 'A'.repeat(30 * 1024 * 1024 + 10) })).status;
  } catch {
    status = 413; // server may close the socket while the client is still sending
  }
  assert.equal(status, 413);
  reply = json200({ data: [{ b64_json: 'OK' }] });
  const big = Buffer.concat([PNG_BYTES, Buffer.alloc(2 * 1024 * 1024, 7)]);
  const res = await edit({ ...editPayload, baseUrl: upstreamUrl, image: big.toString('base64') });
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  const form = await parseMultipart(last());
  assert.deepEqual(Buffer.from(await form.get('image[]').arrayBuffer()), big);
});

test('GET /api/edit is not allowed', async () => {
  assert.equal((await fetch(`${appUrl}/api/edit`)).status, 405);
});

test('edit blocks private upstream addresses and does not follow redirects', async () => {
  let fetched = 0;
  const blocked = await startServer({
    allowPrivateUpstream: false,
    fetchImpl: async () => { fetched++; return new Response('{}'); },
  });
  try {
    for (const host of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '[::1]', '[::ffff:192.168.0.1]', 'user:pass@8.8.8.8']) {
      const res = await fetch(`${blocked.url}/api/edit`, {
        method: 'POST',
        body: JSON.stringify({ ...editPayload, baseUrl: `http://${host}:8080` }),
      });
      assert.equal(res.status, 400, host);
      await res.arrayBuffer();
    }
    assert.equal(fetched, 0);
  } finally {
    blocked.close();
  }
  const seen = [];
  const redirecting = await startServer({
    allowPrivateUpstream: true,
    fetchImpl: async (url, init) => {
      seen.push(init.redirect);
      return new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/x' } });
    },
  });
  try {
    const res = await fetch(`${redirecting.url}/api/edit`, {
      method: 'POST',
      body: JSON.stringify({ ...editPayload, baseUrl: 'https://8.8.8.8' }),
    });
    assert.equal(res.status, 502);
    assert.equal((await res.text()).includes('169.254'), false);
    assert.deepEqual(seen, ['manual']);
  } finally {
    redirecting.close();
  }
});

test('edit never logs or echoes the key, prompt or base URL', async () => {
  const secret = 'sk-EDIT-PRIVATE-5b2d';
  const promptText = 'private edit prompt 77aa';
  const base = 'https://api.example.test/some/path?token=abc';
  const leaky = async () => {
    throw new TypeError(`Failed to parse URL from ${base}/v1/images/edits with ${secret}`, {
      cause: new Error(`connect failed for ${base} using Bearer ${secret}`),
    });
  };
  const s = await startServer({ allowPrivateUpstream: true, fetchImpl: leaky });
  const written = [];
  const capture = (chunk) => { written.push(String(chunk)); return true; };
  const originals = {
    out: process.stdout.write,
    err: process.stderr.write,
    console: Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map((k) => [k, console[k]])),
  };
  const bodies = [];
  process.stdout.write = capture;
  process.stderr.write = capture;
  for (const k of Object.keys(originals.console)) console[k] = (...args) => written.push(args.join(' '));
  try {
    const post = (payload) =>
      fetch(`${s.url}/api/edit`, { method: 'POST', body: JSON.stringify(payload) }).then((r) => r.text());
    const full = { apiKey: secret, prompt: promptText, image: PNG_BYTES.toString('base64') };
    bodies.push(await post({ ...full, baseUrl: base })); // 502
    bodies.push(await post({ ...full, baseUrl: 'ftp://x' })); // 400
    bodies.push(await post({ ...full, image: 'bad!', baseUrl: base })); // 400
  } finally {
    process.stdout.write = originals.out;
    process.stderr.write = originals.err;
    Object.assign(console, originals.console);
    s.close();
  }
  const output = written.join('\n');
  for (const needle of [secret, promptText, 'api.example.test', 'token=abc']) {
    assert.equal(output.includes(needle), false, `logged ${needle}`);
    for (const body of bodies) assert.equal(body.includes(needle), false, `echoed ${needle}`);
  }
});

test('index.html exposes the edit dialog and feed under the CSP', async () => {
  const html = await (await fetch(`${appUrl}/`)).text();
  assert.match(html, /<dialog id="edit-dialog"/);
  assert.match(html, /id="feed"/);
  assert.match(html, /Mô tả chỉnh sửa/);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
});

test('edit forwards several images as ordered image[] parts with their own content types', async () => {
  calls = [];
  reply = json200({ data: [{ b64_json: 'MULTI' }] });
  const images = [
    PNG_BYTES.toString('base64'),
    `data:image/jpeg;base64,${JPEG_BYTES.toString('base64')}`,
    WEBP_BYTES.toString('base64'),
  ];
  const res = await edit({ ...editPayload, image: undefined, images, baseUrl: upstreamUrl });
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  assert.equal(calls.length, 1);
  const form = await parseMultipart(last());
  assert.equal(form.has('image'), false);
  const files = form.getAll('image[]');
  assert.deepEqual(files.map((f) => f.type), ['image/png', 'image/jpeg', 'image/webp']);
  assert.deepEqual(files.map((f) => f.name), ['image1.png', 'image2.jpg', 'image3.webp']);
  assert.deepEqual(Buffer.from(await files[0].arrayBuffer()), PNG_BYTES);
  assert.deepEqual(Buffer.from(await files[1].arrayBuffer()), JPEG_BYTES);
  assert.deepEqual(Buffer.from(await files[2].arrayBuffer()), WEBP_BYTES);
  assert.equal(form.has('n'), false);
});

test('edit rejects more than 4 images, an empty list and any invalid item', async () => {
  calls = [];
  const png = PNG_BYTES.toString('base64');
  const base = { ...editPayload, image: undefined, baseUrl: upstreamUrl };
  for (const [name, images] of Object.entries({
    'five images': [png, png, png, png, png],
    'empty list': [],
    'bad item in the middle': [png, 'not*base64', png],
    'non-image item': [png, Buffer.from('plain text, not an image').toString('base64')],
    'non-string item': [png, 7],
  })) {
    const res = await edit({ ...base, images });
    assert.equal(res.status, 400, name);
    await res.arrayBuffer();
  }
  assert.equal(calls.length, 0);
});

test('edit with n=2 fans out two upstream calls and merges the results in order', async () => {
  calls = [];
  let index = 0;
  const replying = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      calls.push({ headers: req.headers, raw: Buffer.concat(chunks), url: req.url });
      const i = index++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ created: 10 + i, data: [{ b64_json: `OUT${i}` }] }));
    });
  });
  const replyingUrl = await listen(replying);
  try {
    const res = await edit({ ...editPayload, images: [editPayload.image, JPEG_BYTES.toString('base64')], image: undefined, n: 2, baseUrl: replyingUrl });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(calls.length, 2);
    assert.deepEqual(json.data.map((d) => d.b64_json).sort(), ['OUT0', 'OUT1']);
    for (const call of calls) {
      assert.equal(call.url, '/v1/images/edits');
      const form = await parseMultipart(call);
      assert.equal(form.has('n'), false);
      assert.equal(form.getAll('image[]').length, 2);
    }
  } finally {
    replying.close();
    replying.closeAllConnections?.();
  }
});

test('edit with n>1 passes the first failing upstream response through', async () => {
  const s = await startServer({
    allowPrivateUpstream: true,
    fetchImpl: (() => {
      let i = 0;
      return async () => (i++ === 1 ? new Response('slow down', { status: 429, headers: { 'Content-Type': 'text/plain' } }) : new Response(JSON.stringify({ data: [{ b64_json: 'A' }] }), { status: 200 }));
    })(),
  });
  try {
    const res = await fetch(`${s.url}/api/edit`, {
      method: 'POST',
      body: JSON.stringify({ ...editPayload, n: 3, baseUrl: 'https://8.8.8.8' }),
    });
    assert.equal(res.status, 429);
    assert.equal(await res.text(), 'slow down');
  } finally {
    s.close();
  }
});
