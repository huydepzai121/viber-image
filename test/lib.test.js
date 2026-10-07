import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_BASE_URL,
  buildEndpoint,
  buildUpstreamBody,
  describeSource,
  extractImages,
  formatElapsed,
  formatErrorBody,
  makeFilename,
  normalizeBaseUrl,
  sanitizeSettings,
  settingsForStorage,
} from '../public/lib.js';

const FULL = 'https://bedrock.viber.vn/v1/images/generations';

test('buildEndpoint appends the suffix', () => {
  assert.equal(buildEndpoint('https://bedrock.viber.vn'), FULL);
});

test('buildEndpoint normalizes whitespace, trailing slash and existing suffix', () => {
  assert.equal(buildEndpoint(' https://bedrock.viber.vn/v1/images/generations/ '), FULL);
  assert.equal(buildEndpoint('https://bedrock.viber.vn///'), FULL);
  assert.equal(buildEndpoint('https://bedrock.viber.vn/V1/Images/Generations'), FULL);
});

test('buildEndpoint keeps a path prefix', () => {
  assert.equal(buildEndpoint('http://host:8080/proxy/'), 'http://host:8080/proxy/v1/images/generations');
});

test('empty, whitespace or non-string base URL falls back to default', () => {
  for (const value of ['', '   ', undefined, null, '/', 42]) {
    assert.equal(normalizeBaseUrl(value), DEFAULT_BASE_URL);
    assert.equal(buildEndpoint(value), FULL);
  }
});

test('extractImages reads plain b64_json', () => {
  assert.deepEqual(extractImages({ data: [{ b64_json: 'iVBOR' }] }), [{ kind: 'b64', src: 'iVBOR' }]);
});

test('extractImages strips a data: prefix up to the first comma', () => {
  const images = extractImages({ data: [{ b64_json: 'data:image/png;base64,iVBOR' }] });
  assert.deepEqual(images, [{ kind: 'b64', src: 'iVBOR' }]);
});

test('extractImages reads url items and prefers b64_json when both exist', () => {
  assert.deepEqual(extractImages({ data: [{ url: 'https://x/y.png' }] }), [{ kind: 'url', src: 'https://x/y.png' }]);
  assert.deepEqual(extractImages({ data: [{ b64_json: 'AAAA', url: 'https://x/y.png' }] }), [{ kind: 'b64', src: 'AAAA' }]);
});

test('extractImages falls back to url when b64_json is unusable', () => {
  assert.deepEqual(extractImages({ data: [{ b64_json: 'data:image/png;base64,', url: 'https://x/y.png' }] }), [
    { kind: 'url', src: 'https://x/y.png' },
  ]);
});

test('extractImages skips unusable items and tolerates bad shapes', () => {
  assert.deepEqual(extractImages({ data: [{}, null, 'str', { b64_json: '' }, { url: 5 }, { b64_json: 'QQ==' }] }), [
    { kind: 'b64', src: 'QQ==' },
  ]);
  for (const bad of [undefined, null, 'x', {}, { data: null }, { data: {} }, { data: [] }]) {
    assert.deepEqual(extractImages(bad), []);
  }
});

test('describeSource reports field names', () => {
  assert.equal(describeSource([{ kind: 'b64' }]), 'b64_json');
  assert.equal(describeSource([{ kind: 'url' }]), 'url');
  assert.equal(describeSource([{ kind: 'b64' }, { kind: 'url' }]), 'b64_json + url');
});

test('response.txt fixture yields one PNG b64_json image', () => {
  const json = JSON.parse(readFileSync(new URL('../response.txt', import.meta.url), 'utf8'));
  const images = extractImages(json);
  assert.equal(images.length, 1);
  assert.equal(images[0].kind, 'b64');
  assert.equal(describeSource(images), 'b64_json');
  const bytes = Buffer.from(images[0].src, 'base64');
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test('makeFilename: single image has no suffix, zero-padded fields', () => {
  assert.equal(makeFilename(new Date(2026, 9, 6, 14, 30, 22), 0, 1), 'img_20261006_143022.png');
  assert.equal(makeFilename(new Date(2026, 0, 2, 3, 4, 5)), 'img_20260102_030405.png');
});

test('makeFilename: multiple images get _1.._n suffixes', () => {
  const date = new Date(2026, 9, 6, 14, 30, 22);
  assert.deepEqual([0, 1, 2].map((i) => makeFilename(date, i, 3)), [
    'img_20261006_143022_1.png',
    'img_20261006_143022_2.png',
    'img_20261006_143022_3.png',
  ]);
});

test('formatErrorBody pretty-prints JSON and keeps other text raw', () => {
  assert.equal(formatErrorBody('{"error":{"message":"x"}}'), '{\n  "error": {\n    "message": "x"\n  }\n}');
  assert.equal(formatErrorBody('Too many requests'), 'Too many requests');
  assert.equal(formatErrorBody(''), '');
});

test('formatElapsed uses one decimal and a comma', () => {
  assert.equal(formatElapsed(8400), '8,4');
  assert.equal(formatElapsed(960), '1,0');
  assert.equal(formatElapsed(-5), '0,0');
});

test('sanitizeSettings falls back per field', () => {
  assert.deepEqual(sanitizeSettings(null), {
    baseUrl: DEFAULT_BASE_URL, apiKey: '', rememberKey: false, model: 'gpt-image-2-5', prompt: '', size: '1024x1024', n: 1,
  });
  const s = sanitizeSettings({ model: 'x-model', n: 9, size: '5x5', apiKey: 3, prompt: 'cat' });
  assert.equal(s.model, 'x-model');
  assert.equal(s.n, 1);
  assert.equal(s.size, '1024x1024');
  assert.equal(s.apiKey, '');
  assert.equal(s.prompt, ''); // a stored prompt is never restored on load
  assert.equal(sanitizeSettings({ n: 4, size: 'auto' }).n, 4);
  assert.equal(sanitizeSettings({ n: '2' }).n, 1);
  assert.equal(sanitizeSettings([1, 2]).n, 1);
});

test('buildUpstreamBody has the exact key order and default model', () => {
  assert.equal(
    JSON.stringify(buildUpstreamBody({ model: 'gpt-image-2-5', prompt: 'cat', size: '1536x1024', n: 2 })),
    '{"model":"gpt-image-2-5","prompt":"cat","size":"1536x1024","n":2}',
  );
  assert.equal(buildUpstreamBody({ model: '  ', prompt: 'p', size: 'auto', n: 1 }).model, 'gpt-image-2-5');
});

test('a stored API key is only restored when rememberKey is true', () => {
  assert.equal(sanitizeSettings({ apiKey: 'sk-secret' }).apiKey, '');
  assert.equal(sanitizeSettings({ apiKey: 'sk-secret', rememberKey: 'yes' }).apiKey, '');
  const opted = sanitizeSettings({ apiKey: 'sk-secret', rememberKey: true });
  assert.equal(opted.apiKey, 'sk-secret');
  assert.equal(opted.rememberKey, true);
});

test('settingsForStorage drops the API key unless the visitor opted in', () => {
  const base = { baseUrl: 'u', apiKey: 'sk-secret', model: 'm', prompt: 'p', size: 'auto', n: 2 };
  assert.equal(settingsForStorage({ ...base, rememberKey: false }).apiKey, '');
  assert.equal(JSON.stringify(settingsForStorage({ ...base, rememberKey: false })).includes('sk-secret'), false);
  assert.equal(settingsForStorage({ ...base, rememberKey: true }).apiKey, 'sk-secret');
  assert.equal(base.apiKey, 'sk-secret'); // input is not mutated
});

test('settingsForStorage never writes the prompt', () => {
  const stored = settingsForStorage({ baseUrl: 'u', apiKey: '', rememberKey: false, model: 'm', prompt: 'secret cat', size: 'auto', n: 2 });
  assert.equal('prompt' in stored, false);
});
