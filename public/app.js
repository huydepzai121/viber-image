import {
  DEFAULT_BASE_URL,
  ENDPOINT_PATH,
  buildUpstreamBody,
  describeSource,
  extractImages,
  formatElapsed,
  formatErrorBody,
  makeFilename,
  normalizeBaseUrl,
  sanitizeSettings,
} from './lib.js';

const STORAGE_KEY = 'viber-image-settings';
const DOWNLOAD_DELAY_MS = 350;
const SVG_NS = 'http://www.w3.org/2000/svg';

const $ = (id) => document.getElementById(id);
const el = {
  baseUrl: $('baseurl'),
  apiKey: $('apikey'),
  apiKeyError: $('apikey-error'),
  toggleKey: $('toggle-key'),
  eyeOn: $('eye-on'),
  eyeOff: $('eye-off'),
  model: $('model'),
  prompt: $('prompt'),
  promptError: $('prompt-error'),
  sizes: $('sizes'),
  counts: $('counts'),
  generate: $('generate'),
  genSpinner: $('gen-spinner'),
  genLabel: $('gen-label'),
  requestPreview: $('request-preview'),
  announcer: $('announcer'),
  bannerSuccess: $('banner-success'),
  successTitle: $('success-title'),
  successSource: $('success-source'),
  successNote: $('success-note'),
  dismissSuccess: $('dismiss-success'),
  bannerError: $('banner-error'),
  errorTitle: $('error-title'),
  errorBody: $('error-body'),
  copyError: $('copy-error'),
  downloadAll: $('download-all'),
  downloadAllLabel: $('download-all-label'),
  downloadError: $('download-error'),
  resultIdle: $('result-idle'),
  resultGrid: $('result-grid'),
  resultError: $('result-error'),
};

const state = {
  settings: loadSettings(),
  showKey: false,
  phase: 'idle', // idle | loading | success | error
  result: null, // { images, stamp, sourceField, elapsed }
  error: null, // { title, body }
  bannerDismissed: false,
};

/* ---------- storage ---------- */

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return sanitizeSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return sanitizeSettings(null);
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
  } catch {
    /* storage unavailable: keep working with in-memory settings */
  }
}

/* ---------- helpers ---------- */

function announce(message) {
  el.announcer.textContent = '';
  // Re-set on the next frame so identical messages are announced again.
  requestAnimationFrame(() => { el.announcer.textContent = message; });
}

function aspectRatio(size) {
  if (size === '1536x1024') return '3 / 2';
  if (size === '1024x1536') return '2 / 3';
  return '1 / 1';
}

function b64ToBlob(b64) {
  const binary = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}

function spinnerSvg(size) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('spin');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M21 12a9 9 0 1 1-6.2-8.56');
  svg.appendChild(path);
  return svg;
}

function downloadIconSvg() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({
    width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '2.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
  })) svg.setAttribute(k, v);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M12 3v12M7 10l5 5 5-5M5 21h14');
  svg.appendChild(path);
  return svg;
}

function releaseResult() {
  if (!state.result) return;
  for (const image of state.result.images) {
    if (image.blobUrl) URL.revokeObjectURL(image.blobUrl);
  }
  state.result = null;
}

/* ---------- rendering ---------- */

function renderRequestPreview() {
  const { baseUrl, model, prompt, size, n } = state.settings;
  // Upstream only accepts n = 1, so the local server sends `n` such requests.
  const body = buildUpstreamBody({ model, prompt: prompt.trim() === '' ? '…' : prompt, size, n: 1 });
  const times = n > 1 ? ` (× ${n} request song song, mỗi request n = 1)` : '';
  el.requestPreview.textContent =
    `POST ${normalizeBaseUrl(baseUrl)}${ENDPOINT_PATH}${times}\n` +
    'Authorization: Bearer ••••••••\n' +
    'Content-Type: application/json\n\n' +
    JSON.stringify(body, null, 2);
}

function renderChoices() {
  for (const tile of el.sizes.querySelectorAll('[data-size]')) {
    tile.setAttribute('aria-pressed', String(tile.dataset.size === state.settings.size));
  }
  for (const seg of el.counts.querySelectorAll('[data-n]')) {
    seg.setAttribute('aria-pressed', String(Number(seg.dataset.n) === state.settings.n));
  }
}

function renderKeyToggle() {
  el.apiKey.type = state.showKey ? 'text' : 'password';
  el.toggleKey.setAttribute('aria-label', state.showKey ? 'Ẩn API key' : 'Hiện API key');
  el.eyeOn.hidden = state.showKey;
  el.eyeOff.hidden = !state.showKey;
}

function buildLoadingGrid() {
  const { n, size } = state.settings;
  el.resultGrid.replaceChildren();
  el.resultGrid.className = n === 1 ? 'grid single' : 'grid';
  for (let i = 1; i <= n; i++) {
    const frame = document.createElement('div');
    frame.className = 'frame loading';
    frame.style.aspectRatio = aspectRatio(size);
    frame.appendChild(spinnerSvg(22));
    frame.appendChild(document.createTextNode(`Đang tạo ảnh ${i}…`));
    el.resultGrid.appendChild(frame);
  }
}

function buildResultGrid() {
  const { images, stamp } = state.result;
  const total = images.length;
  el.resultGrid.replaceChildren();
  el.resultGrid.className = total === 1 ? 'grid single' : 'grid';
  images.forEach((image, index) => {
    const figure = document.createElement('figure');

    const frame = document.createElement('div');
    frame.className = 'frame done';
    frame.style.aspectRatio = aspectRatio(state.result.size);
    const img = document.createElement('img');
    img.alt = `Ảnh kết quả ${index + 1}`;
    img.decoding = 'async';
    if (image.kind === 'b64') {
      img.src = image.blobUrl;
    } else {
      img.src = image.src;
      // Remote host may block hot-linking; retry once through the local proxy.
      img.addEventListener('error', async () => {
        if (img.dataset.proxied) return;
        img.dataset.proxied = '1';
        try {
          img.src = await ensureBlobUrl(image);
        } catch (err) {
          showDownloadError(`Không hiển thị được ảnh ${index + 1}: ${err.message}`);
        }
      });
    }
    frame.appendChild(img);
    const tag = document.createElement('span');
    tag.className = 'source-tag';
    tag.textContent = image.kind === 'b64' ? 'b64_json' : 'url';
    frame.appendChild(tag);
    figure.appendChild(frame);

    const caption = document.createElement('figcaption');
    const filename = makeFilename(stamp, index, total);
    const code = document.createElement('code');
    code.textContent = filename;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dl-btn';
    button.appendChild(downloadIconSvg());
    button.appendChild(document.createTextNode('Tải về'));
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await downloadImage(index);
      } finally {
        button.disabled = false;
      }
    });
    caption.append(code, button);
    figure.appendChild(caption);
    el.resultGrid.appendChild(figure);
  });
}

function render() {
  const { phase } = state;
  const loading = phase === 'loading';

  el.generate.disabled = loading;
  el.genSpinner.hidden = !loading;
  el.genLabel.textContent = loading ? 'Đang tạo ảnh…' : 'Tạo ảnh';

  el.bannerSuccess.hidden = !(phase === 'success' && !state.bannerDismissed);
  el.bannerError.hidden = phase !== 'error';
  el.resultIdle.hidden = phase !== 'idle';
  el.resultError.hidden = phase !== 'error';
  el.resultGrid.hidden = !(loading || phase === 'success');
  el.downloadAll.hidden = phase !== 'success';

  if (phase === 'success') {
    const total = state.result.images.length;
    el.successTitle.textContent = `Đã tạo ${total} ảnh · ${formatElapsed(state.result.elapsed)} giây`;
    el.successSource.textContent = state.result.sourceField;
    el.successNote.textContent = state.result.sourceField === 'b64_json'
      ? 'đã giải mã base64'
      : state.result.sourceField === 'url'
        ? 'tải ảnh từ URL máy chủ trả về'
        : 'đã giải mã base64 và tải ảnh từ URL';
    el.downloadAllLabel.textContent = `Tải tất cả (${total})`;
  }
  if (phase === 'error') {
    el.errorTitle.textContent = state.error.title;
    el.errorBody.textContent = state.error.body;
    el.copyError.textContent = 'Sao chép';
  }
}

/* ---------- downloads ---------- */

function showDownloadError(message) {
  el.downloadError.textContent = message;
  el.downloadError.hidden = false;
}

function clearDownloadError() {
  el.downloadError.hidden = true;
  el.downloadError.textContent = '';
}

async function ensureBlobUrl(image) {
  if (image.blobUrl) return image.blobUrl;
  const response = await fetch(`/api/fetch-image?url=${encodeURIComponent(image.src)}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  }
  const blob = await response.blob();
  image.blobUrl = URL.createObjectURL(blob);
  return image.blobUrl;
}

async function downloadImage(index) {
  if (!state.result) return false;
  const { images, stamp } = state.result;
  const image = images[index];
  clearDownloadError();
  try {
    const href = await ensureBlobUrl(image);
    const a = document.createElement('a');
    a.href = href;
    a.download = makeFilename(stamp, index, images.length);
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } catch (err) {
    showDownloadError(`Không tải được ảnh ${index + 1}: ${err.message}`);
    return false;
  }
}

async function downloadAll() {
  if (!state.result) return;
  const result = state.result;
  el.downloadAll.disabled = true;
  try {
    for (let i = 0; i < result.images.length; i++) {
      if (state.result !== result) break;
      await downloadImage(i);
      if (i < result.images.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_DELAY_MS));
      }
    }
  } finally {
    el.downloadAll.disabled = false;
  }
}

/* ---------- generate ---------- */

function clearFieldErrors() {
  for (const [input, message] of [[el.apiKey, el.apiKeyError], [el.prompt, el.promptError]]) {
    message.hidden = true;
    message.textContent = '';
    input.removeAttribute('aria-invalid');
  }
}

function flagField(input, message, text) {
  message.textContent = text;
  message.hidden = false;
  input.setAttribute('aria-invalid', 'true');
}

function validate() {
  clearFieldErrors();
  const invalid = [];
  if (state.settings.apiKey.trim() === '') {
    flagField(el.apiKey, el.apiKeyError, 'Vui lòng nhập API key.');
    invalid.push(el.apiKey);
  }
  if (state.settings.prompt.trim() === '') {
    flagField(el.prompt, el.promptError, 'Vui lòng nhập prompt.');
    invalid.push(el.prompt);
  }
  if (invalid.length > 0) {
    invalid[0].focus();
    announce(invalid[0] === el.apiKey ? 'Vui lòng nhập API key.' : 'Vui lòng nhập prompt.');
    return false;
  }
  return true;
}

function fail(title, body) {
  releaseResult();
  state.phase = 'error';
  state.error = { title, body };
  render();
  announce(title);
}

async function generate() {
  if (state.phase === 'loading') return;
  if (!validate()) return;

  const { baseUrl, apiKey, model, prompt, size, n } = state.settings;
  releaseResult();
  clearDownloadError();
  state.phase = 'loading';
  state.error = null;
  state.bannerDismissed = false;
  buildLoadingGrid();
  render();
  announce('Đang tạo ảnh…');

  const started = performance.now();
  let response;
  let text;
  try {
    response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl, apiKey: apiKey.trim(), model: model.trim(), prompt, size, n }),
    });
    text = await response.text();
  } catch (err) {
    fail('Lỗi kết nối', formatErrorBody(JSON.stringify({ error: { message: err.message || String(err) } })));
    return;
  }
  const elapsed = performance.now() - started;
  const stamp = new Date();
  const status = `HTTP ${response.status}${response.statusText ? ' ' + response.statusText : ''}`;

  if (!response.ok) {
    fail(`Tạo ảnh thất bại · ${status}`, formatErrorBody(text));
    return;
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    fail(`Tạo ảnh thất bại · ${status} · Phản hồi không phải JSON`, text);
    return;
  }

  const images = extractImages(json);
  if (images.length === 0) {
    fail(`Phản hồi không chứa ảnh · ${status}`, formatErrorBody(text));
    return;
  }

  try {
    for (const image of images) {
      if (image.kind === 'b64') image.blobUrl = URL.createObjectURL(b64ToBlob(image.src));
    }
  } catch {
    for (const image of images) if (image.blobUrl) URL.revokeObjectURL(image.blobUrl);
    fail(`Tạo ảnh thất bại · ${status} · Không giải mã được base64`, formatErrorBody(text));
    return;
  }

  state.result = { images, stamp, size, elapsed, sourceField: describeSource(images) };
  state.phase = 'success';
  buildResultGrid();
  render();
  announce(`Đã tạo ${images.length} ảnh trong ${formatElapsed(elapsed)} giây`);
}

/* ---------- copy ---------- */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }
}

/* ---------- events ---------- */

function update(patch) {
  Object.assign(state.settings, patch);
  saveSettings();
  renderRequestPreview();
}

el.baseUrl.addEventListener('input', () => {
  update({ baseUrl: el.baseUrl.value });
});
el.apiKey.addEventListener('input', () => {
  update({ apiKey: el.apiKey.value });
  if (el.apiKey.value.trim() !== '') {
    el.apiKeyError.hidden = true;
    el.apiKey.removeAttribute('aria-invalid');
  }
});
el.model.addEventListener('input', () => update({ model: el.model.value }));
el.prompt.addEventListener('input', () => {
  update({ prompt: el.prompt.value });
  if (el.prompt.value.trim() !== '') {
    el.promptError.hidden = true;
    el.prompt.removeAttribute('aria-invalid');
  }
});
el.prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    generate();
  }
});
el.toggleKey.addEventListener('click', () => {
  state.showKey = !state.showKey;
  renderKeyToggle();
});
el.sizes.addEventListener('click', (event) => {
  const tile = event.target.closest('[data-size]');
  if (!tile) return;
  update({ size: tile.dataset.size });
  renderChoices();
});
el.counts.addEventListener('click', (event) => {
  const seg = event.target.closest('[data-n]');
  if (!seg) return;
  update({ n: Number(seg.dataset.n) });
  renderChoices();
});
el.generate.addEventListener('click', generate);
el.dismissSuccess.addEventListener('click', () => {
  state.bannerDismissed = true;
  render();
});
el.copyError.addEventListener('click', async () => {
  const ok = await copyText(state.error ? state.error.body : '');
  el.copyError.textContent = ok ? 'Đã sao chép' : 'Không sao chép được';
  announce(el.copyError.textContent);
  setTimeout(() => { if (state.phase === 'error') el.copyError.textContent = 'Sao chép'; }, 2000);
});
el.downloadAll.addEventListener('click', downloadAll);

/* ---------- theme ---------- */

const THEME_KEY = 'viber-image-theme';
const themeToggle = $('theme-toggle');
const lightQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

function readStoredTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const dark = theme === 'dark';
  themeToggle.setAttribute('aria-pressed', String(dark));
  themeToggle.setAttribute('aria-label', dark ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối');
}

function systemTheme() {
  return lightQuery && lightQuery.matches ? 'light' : 'dark';
}

themeToggle.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, next); } catch { /* storage unavailable: choice lasts for this page only */ }
  applyTheme(next);
});
if (lightQuery) {
  lightQuery.addEventListener('change', () => {
    if (!readStoredTheme()) applyTheme(systemTheme());
  });
}
applyTheme(readStoredTheme() || systemTheme());

/* ---------- init ---------- */

el.baseUrl.value = state.settings.baseUrl;
el.baseUrl.placeholder = DEFAULT_BASE_URL;
el.apiKey.value = state.settings.apiKey;
el.model.value = state.settings.model;
el.prompt.value = state.settings.prompt;
renderRequestPreview();
renderChoices();
renderKeyToggle();
render();
