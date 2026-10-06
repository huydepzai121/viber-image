import test from 'node:test';
import assert from 'node:assert/strict';
import { errorHint } from '../public/lib.js';

test('errorHint explains a 413 as an oversized request, not a bad key', () => {
  assert.match(errorHint(413), /vượt giới hạn/);
  assert.match(errorHint(413), /client_max_body_size/);
  assert.doesNotMatch(errorHint(413), /API key/);
});

test('errorHint maps auth, not-found, rate-limit and server statuses', () => {
  assert.match(errorHint(401), /API key/);
  assert.match(errorHint(403), /API key/);
  assert.match(errorHint(404), /Base URL và model/);
  assert.match(errorHint(429), /tần suất/);
  assert.match(errorHint(502), /kết nối/);
  assert.match(errorHint(500), /phía máy chủ/);
  assert.match(errorHint(400), /Kiểm tra API key, Base URL hoặc model/);
});
