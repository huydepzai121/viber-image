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
  // The mock upstream runs on 127.0.0.1, so the private-address check is off here.
  app = createServer({ allowPrivateUpstream: true });
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

/* ---------- privacy, headers and upstream restrictions ---------- */

const startServer = async (options) => {
  const server = createServer(options);
  const url = await listen(server);
  return { server, url, close: () => { server.close(); server.closeAllConnections?.(); } };
};

test('security headers are set on API, static and error responses', async () => {
  for (const path of ['/', '/app.js', '/nope.txt', '/api/generate', '/api/fetch-image?url=garbage']) {
    const res = await fetch(`${appUrl}${path}`);
    await res.arrayBuffer();
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/, path);
    assert.match(csp, /script-src 'self'(;|$)/, path);
    assert.match(csp, /style-src 'self' https:\/\/fonts\.googleapis\.com/, path);
    assert.match(csp, /font-src https:\/\/fonts\.gstatic\.com/, path);
    assert.match(csp, /img-src 'self' data: blob: https:/, path);
    assert.match(csp, /connect-src 'self'/, path);
    assert.match(csp, /base-uri 'none'/, path);
    assert.match(csp, /form-action 'none'/, path);
    assert.match(csp, /frame-ancestors 'none'/, path);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer', path);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(res.headers.get('x-frame-options'), 'DENY', path);
    if (path.startsWith('/api/')) assert.equal(res.headers.get('cache-control'), 'no-store', path);
  }
  reply = { status: 200, headers: { 'Content-Type': 'image/png' }, body: Buffer.from([1, 2, 3]) };
  const ok = await fetch(`${appUrl}/api/fetch-image?url=${encodeURIComponent(upstreamUrl + '/x.png')}`);
  await ok.arrayBuffer();
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal(ok.headers.get('x-frame-options'), 'DENY');
});

test('index.html works under the CSP: no inline script, style attribute or handler', async () => {
  const html = await (await fetch(`${appUrl}/`)).text();
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.doesNotMatch(html, /<style[\s>]/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.match(html, /<script src="\/theme-init\.js"><\/script>/);
  assert.equal((await fetch(`${appUrl}/theme-init.js`)).status, 200);
});

test('the server never writes the API key, prompt or base URL to stdout/stderr/console', async () => {
  const secret = 'sk-PRIVATE-do-not-log-7f3a';
  const promptText = 'a very private prompt 9c1e';
  const written = [];
  const capture = (chunk) => { written.push(String(chunk)); return true; };
  const originals = {
    out: process.stdout.write,
    err: process.stderr.write,
    console: Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map((k) => [k, console[k]])),
  };
  const dead = http.createServer();
  const deadUrl = await listen(dead);
  await new Promise((resolve) => dead.close(resolve));
  const bodies = [];
  process.stdout.write = capture;
  process.stderr.write = capture;
  for (const k of Object.keys(originals.console)) console[k] = (...args) => written.push(args.join(' '));
  try {
    reply = json200({ data: [{ b64_json: 'AAAA' }] });
    await (await generate({ apiKey: secret, prompt: promptText, baseUrl: upstreamUrl, n: 2 })).text();
    bodies.push(await (await generate({ apiKey: secret, prompt: promptText, baseUrl: deadUrl })).text()); // 502
    bodies.push(await (await generate({ apiKey: secret, prompt: promptText, baseUrl: 'ftp://x' })).text()); // 400
    bodies.push(await (await generate(null, '{"apiKey":"' + secret + '", broken')).text()); // bad JSON
  } finally {
    process.stdout.write = originals.out;
    process.stderr.write = originals.err;
    Object.assign(console, originals.console);
  }
  const output = written.join('\n');
  for (const needle of [secret, promptText, upstreamUrl, deadUrl]) {
    assert.equal(output.includes(needle), false, `logged ${needle}`);
  }
  for (const body of bodies) {
    for (const needle of [secret, promptText, deadUrl]) assert.equal(body.includes(needle), false, `echoed ${needle}`);
  }
});

test('502 messages never contain the upstream URL or API key', async () => {
  const secret = 'sk-LEAKY-1234';
  const base = 'https://api.example.test/some/path?token=abc';
  const leaky = async () => {
    throw new TypeError(`Failed to parse URL from ${base}/v1/images/generations with ${secret}`, {
      cause: new Error(`connect failed for ${base} using Bearer ${secret}`),
    });
  };
  const s = await startServer({ allowPrivateUpstream: true, fetchImpl: leaky });
  try {
    const res = await fetch(`${s.url}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({ apiKey: secret, prompt: 'p', baseUrl: base }),
    });
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.equal(text.includes(secret), false);
    assert.equal(text.includes('api.example.test'), false);
    assert.equal(text.includes('token=abc'), false);
    const img = await fetch(`${s.url}/api/fetch-image?url=${encodeURIComponent(base + '/i.png')}`);
    assert.equal(img.status, 502);
    assert.equal((await img.text()).includes('api.example.test'), false);
  } finally {
    s.close();
  }
});

test('private, loopback, link-local and reserved upstream addresses are blocked with 400', async () => {
  let fetched = 0;
  const s = await startServer({
    allowPrivateUpstream: false,
    fetchImpl: async () => { fetched += 1; return new Response('{}'); },
  });
  const hosts = [
    '127.0.0.1', '127.8.8.8', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '100.127.255.255', '0.0.0.0', '0.1.2.3', '224.0.0.1', '255.255.255.255',
    '[::1]', '[::]', '[fc00::1]', '[fd12:3456::1]', '[fe80::1]', '[ff02::1]',
    '[::ffff:127.0.0.1]', '[::ffff:10.0.0.1]', '[::ffff:169.254.169.254]', '[::ffff:192.168.0.1]',
    '2130706433', '0x7f.1', '017700000001', // normalised to 127.0.0.1 by the URL parser
  ];
  try {
    for (const host of hosts) {
      const base = `http://${host}:8080`;
      const gen = await fetch(`${s.url}/api/generate`, {
        method: 'POST',
        body: JSON.stringify({ apiKey: 'k', prompt: 'p', baseUrl: base }),
      });
      assert.equal(gen.status, 400, `generate ${host}`);
      assert.equal(typeof (await gen.json()).error.message, 'string');
      const img = await fetch(`${s.url}/api/fetch-image?url=${encodeURIComponent(base + '/a.png')}`);
      assert.equal(img.status, 400, `fetch-image ${host}`);
      await img.arrayBuffer();
    }
    assert.equal(fetched, 0, 'blocked requests must never reach fetch');
  } finally {
    s.close();
  }
});

test('public literal addresses are allowed when the check is on', async () => {
  let seen = 0;
  const s = await startServer({
    allowPrivateUpstream: false,
    fetchImpl: async () => { seen += 1; return new Response('{"data":[]}', { status: 200 }); },
  });
  try {
    for (const host of ['8.8.8.8', '[2606:4700:4700::1111]', '172.32.0.1', '100.128.0.1']) {
      const res = await fetch(`${s.url}/api/generate`, {
        method: 'POST',
        body: JSON.stringify({ apiKey: 'k', prompt: 'p', baseUrl: `https://${host}` }),
      });
      assert.equal(res.status, 200, host);
      await res.arrayBuffer();
    }
    assert.equal(seen, 4);
  } finally {
    s.close();
  }
});

test('hostnames are resolved and rejected when any address is private', async () => {
  const table = {
    'internal.example': [{ address: '10.0.0.5', family: 4 }],
    'mixed.example': [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }],
    'v6.example': [{ address: 'fe80::1%eth0', family: 6 }],
    'public.example': [{ address: '8.8.4.4', family: 4 }],
  };
  const s = await startServer({
    allowPrivateUpstream: false,
    lookup: async (host) => { if (!table[host]) throw new Error('ENOTFOUND'); return table[host]; },
    fetchImpl: async () => new Response('{"data":[]}', { status: 200 }),
  });
  const status = async (host) =>
    (await fetch(`${s.url}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({ apiKey: 'k', prompt: 'p', baseUrl: `https://${host}` }),
    })).status;
  try {
    assert.equal(await status('internal.example'), 400);
    assert.equal(await status('mixed.example'), 400);
    assert.equal(await status('v6.example'), 400);
    assert.equal(await status('missing.example'), 400);
    assert.equal(await status('public.example'), 200);
  } finally {
    s.close();
  }
});

test('URLs with user:password are rejected even when private upstreams are allowed', async () => {
  for (const options of [{ allowPrivateUpstream: false }, { allowPrivateUpstream: true }]) {
    const s = await startServer({ ...options, fetchImpl: async () => new Response('{}') });
    try {
      const gen = await fetch(`${s.url}/api/generate`, {
        method: 'POST',
        body: JSON.stringify({ apiKey: 'k', prompt: 'p', baseUrl: 'https://user:pass@8.8.8.8' }),
      });
      assert.equal(gen.status, 400);
      assert.equal((await gen.text()).includes('pass@'), false);
      const img = await fetch(`${s.url}/api/fetch-image?url=${encodeURIComponent('https://user@8.8.8.8/a.png')}`);
      assert.equal(img.status, 400);
      await img.arrayBuffer();
    } finally {
      s.close();
    }
  }
});

test('no environment variable can turn the address check off', async () => {
  const previous = process.env.ALLOW_PRIVATE_UPSTREAM;
  process.env.ALLOW_PRIVATE_UPSTREAM = '1';
  let calls = 0;
  const s = await startServer({ fetchImpl: async () => { calls++; return new Response('{"data":[]}'); } });
  try {
    const res = await fetch(`${s.url}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({ apiKey: 'k', prompt: 'p', baseUrl: 'http://127.0.0.1:9' }),
    });
    assert.equal(res.status, 400);
    assert.equal(calls, 0);
  } finally {
    s.close();
    if (previous === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAM;
    else process.env.ALLOW_PRIVATE_UPSTREAM = previous;
  }
});

test('upstream redirects are not followed (generate and fetch-image)', async () => {
  const seen = [];
  const s = await startServer({
    allowPrivateUpstream: true,
    fetchImpl: async (url, init) => {
      seen.push(init.redirect);
      return new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data' } });
    },
  });
  try {
    const gen = await fetch(`${s.url}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({ apiKey: 'k', prompt: 'p', baseUrl: 'https://8.8.8.8' }),
    });
    assert.equal(gen.status, 502);
    assert.equal((await gen.text()).includes('169.254'), false);
    const img = await fetch(`${s.url}/api/fetch-image?url=${encodeURIComponent('https://8.8.8.8/a.png')}`);
    assert.equal(img.status, 502);
    assert.equal((await img.text()).includes('169.254'), false);
    assert.deepEqual(seen, ['manual', 'manual']);
  } finally {
    s.close();
  }
});

test('a real redirect from the upstream is returned as an error, not followed', async () => {
  const hops = [];
  const target = http.createServer((req, res) => { hops.push(req.url); res.end('secret'); });
  const targetUrl = await listen(target);
  const redirector = http.createServer((req, res) => {
    res.writeHead(302, { Location: `${targetUrl}/internal` });
    res.end();
  });
  const redirectorUrl = await listen(redirector);
  try {
    const res = await fetch(`${appUrl}/api/fetch-image?url=${encodeURIComponent(redirectorUrl + '/x.png')}`);
    assert.equal(res.status, 502);
    assert.equal((await res.text()).includes('secret'), false);
    assert.deepEqual(hops, []);
  } finally {
    target.close();
    redirector.close();
    target.closeAllConnections?.();
    redirector.closeAllConnections?.();
  }
});

test('fetch-image enforces the response size cap', async () => {
  const s = await startServer({ allowPrivateUpstream: true, maxImageBytes: 1000 });
  try {
    // Declared length over the cap is refused before streaming.
    reply = { status: 200, headers: { 'Content-Type': 'image/png', 'Content-Length': '2000' }, body: Buffer.alloc(2000, 1) };
    const big = await fetch(`${s.url}/api/fetch-image?url=${encodeURIComponent(upstreamUrl + '/big.png')}`);
    assert.equal(big.status, 413);
    await big.arrayBuffer();
    // A body without a declared length is cut off once it passes the cap.
    const chunked = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.write(Buffer.alloc(800, 1));
      setTimeout(() => res.end(Buffer.alloc(800, 1)), 20);
    });
    const chunkedUrl = await listen(chunked);
    try {
      let received = 0;
      let failed = false;
      try {
        const res = await fetch(`${s.url}/api/fetch-image?url=${encodeURIComponent(chunkedUrl + '/c.png')}`);
        received = (await res.arrayBuffer()).byteLength;
      } catch {
        failed = true;
      }
      assert.ok(failed || received <= 1000, 'oversized streamed body must not be delivered in full');
    } finally {
      chunked.close();
      chunked.closeAllConnections?.();
    }
    // Within the cap still works.
    reply = { status: 200, headers: { 'Content-Type': 'image/png' }, body: Buffer.alloc(500, 1) };
    const small = await fetch(`${s.url}/api/fetch-image?url=${encodeURIComponent(upstreamUrl + '/ok.png')}`);
    assert.equal(small.status, 200);
    assert.equal((await small.arrayBuffer()).byteLength, 500);
  } finally {
    s.close();
  }
});
