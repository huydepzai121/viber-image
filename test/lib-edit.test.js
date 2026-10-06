import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEditEndpoint,
  detectImageType,
  estimateProgress,
  formatClock,
  isValidBase64,
  stripDataUrlPrefix,
} from '../public/lib.js';

test('buildEditEndpoint appends the edits path and strips either known suffix', () => {
  const EDIT = 'https://bedrock.viber.vn/v1/images/edits';
  assert.equal(buildEditEndpoint('https://bedrock.viber.vn'), EDIT);
  assert.equal(buildEditEndpoint(' https://bedrock.viber.vn/v1/images/generations/ '), EDIT);
  assert.equal(buildEditEndpoint('https://bedrock.viber.vn/v1/images/edits'), EDIT);
  assert.equal(buildEditEndpoint(''), EDIT);
});

test('estimateProgress starts at 0, is monotonic and never exceeds 95', () => {
  assert.equal(estimateProgress(0), 0);
  assert.equal(estimateProgress(-10), 0);
  assert.equal(estimateProgress(NaN), 0);
  let previous = -1;
  for (let ms = 0; ms <= 600_000; ms += 500) {
    const value = estimateProgress(ms, 60_000);
    assert.ok(Number.isInteger(value));
    assert.ok(value >= previous, `not monotonic at ${ms}`);
    assert.ok(value <= 95, `above 95 at ${ms}`);
    previous = value;
  }
  assert.equal(estimateProgress(1e12), 95);
  assert.equal(estimateProgress(Infinity), 95);
});

test('estimateProgress scales with the expected duration and defaults to 60 s', () => {
  assert.equal(estimateProgress(30_000), estimateProgress(30_000, 60_000));
  assert.ok(estimateProgress(10_000, 20_000) > estimateProgress(10_000, 60_000));
  const half = estimateProgress(30_000, 60_000);
  assert.ok(half > 40 && half < 90, String(half));
  assert.equal(estimateProgress(1000, 0), 0);
});

test('stripDataUrlPrefix removes data: up to the first comma only', () => {
  assert.equal(stripDataUrlPrefix('data:image/png;base64,iVBOR'), 'iVBOR');
  assert.equal(stripDataUrlPrefix('  iVBOR  '), 'iVBOR');
  assert.equal(stripDataUrlPrefix('data:image/png;base64,'), '');
  assert.equal(stripDataUrlPrefix('data:nocomma'), '');
  assert.equal(stripDataUrlPrefix(null), '');
});

test('isValidBase64 accepts padded base64 with whitespace and rejects the rest', () => {
  assert.equal(isValidBase64('QUJD'), true);
  assert.equal(isValidBase64('QUI='), true);
  assert.equal(isValidBase64('QQ=='), true);
  assert.equal(isValidBase64('QU JD\n'), true);
  for (const bad of ['', 'QUJ', 'QU*D', 'Q===', '=QUJ', null, 5]) assert.equal(isValidBase64(bad), false, String(bad));
});

test('detectImageType recognises PNG, JPEG and WEBP by magic bytes', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), Buffer.alloc(12)]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)]);
  assert.equal(detectImageType(png), 'image/png');
  assert.equal(detectImageType(jpeg), 'image/jpeg');
  assert.equal(detectImageType(webp), 'image/webp');
  assert.equal(detectImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(4)])), null);
  assert.equal(detectImageType(Buffer.from('GIF89a......')), null);
  assert.equal(detectImageType(Buffer.from([0x89, 0x50])), null);
  assert.equal(detectImageType(null), null);
});

test('decoding a data-prefixed payload round-trips the bytes', () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const payload = stripDataUrlPrefix('data:image/png;base64,' + bytes.toString('base64'));
  assert.equal(isValidBase64(payload), true);
  assert.deepEqual(Buffer.from(payload, 'base64'), bytes);
  assert.equal(detectImageType(Buffer.from(payload, 'base64')), 'image/png');
});

test('formatClock is HH:MM:SS with zero padding', () => {
  assert.equal(formatClock(new Date(2026, 9, 6, 4, 5, 9)), '04:05:09');
  assert.equal(formatClock(new Date(2026, 9, 6, 14, 30, 22)), '14:30:22');
});

test('expectedDuration: 60 s plain, 70 s up to 2 images, +15 s per extra image', async () => {
  const { expectedDuration } = await import('../public/lib.js');
  assert.equal(expectedDuration(0), 60_000);
  assert.equal(expectedDuration(), 60_000);
  assert.equal(expectedDuration(1), 70_000);
  assert.equal(expectedDuration(2), 70_000);
  assert.equal(expectedDuration(3), 85_000);
  assert.equal(expectedDuration(4), 100_000);
});

test('checkAttachment enforces type, count, per-file and total limits', async () => {
  const { checkAttachment, MAX_ATTACHMENT_BYTES, MAX_TOTAL_IMAGE_BYTES } = await import('../public/lib.js');
  const png = (size) => ({ type: 'image/png', size, name: 'a.png' });
  assert.equal(checkAttachment({ count: 0, totalBytes: 0 }, png(1000)), null);
  assert.equal(checkAttachment({ count: 0, totalBytes: 0 }, { type: 'image/webp', size: 1 }), null);
  assert.match(checkAttachment({ count: 0, totalBytes: 0 }, { type: 'image/gif', size: 1, name: 'x.gif' }), /PNG, JPEG/);
  assert.match(checkAttachment({ count: 0, totalBytes: 0 }, null), /PNG, JPEG/);
  assert.match(checkAttachment({ count: 4, totalBytes: 0 }, png(1)), /Tối đa 4/);
  assert.equal(checkAttachment({ count: 3, totalBytes: 0 }, png(1)), null);
  assert.match(checkAttachment({ count: 0, totalBytes: 0 }, png(MAX_ATTACHMENT_BYTES + 1)), /20 MB/);
  assert.equal(checkAttachment({ count: 0, totalBytes: 0 }, png(MAX_ATTACHMENT_BYTES)), null);
  assert.match(checkAttachment({ count: 1, totalBytes: MAX_TOTAL_IMAGE_BYTES - 5 }, png(10)), /Tổng dung lượng/);
  assert.equal(checkAttachment({ count: 1, totalBytes: MAX_TOTAL_IMAGE_BYTES - 10 }, png(10)), null);
});
