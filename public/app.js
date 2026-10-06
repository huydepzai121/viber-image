import {
  DEFAULT_BASE_URL,
  EDIT_ENDPOINT_PATH,
  ENDPOINT_PATH,
  buildUpstreamBody,
  checkAttachment,
  describeSource,
  estimateProgress,
  expectedDuration,
  extractImages,
  formatClock,
  formatElapsed,
  formatErrorBody,
  makeFilename,
  normalizeBaseUrl,
  sanitizeSettings,
  settingsForStorage,
  stripDataUrlPrefix,
} from './lib.js';

const STORAGE_KEY = 'viber-image-settings';
const DOWNLOAD_DELAY_MS = 350;
const PROGRESS_TICK_MS = 250;
const PROGRESS_DONE_HOLD_MS = 450;
const SVG_NS = 'http://www.w3.org/2000/svg';

const $ = (id) => document.getElementById(id);
const el = {
  baseUrl: $('baseurl'),
  apiKey: $('apikey'),
  apiKeyError: $('apikey-error'),
  rememberKey: $('remember-key'),
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
  clearAll: $('clear-all'),
  downloadError: $('download-error'),
  resultIdle: $('result-idle'),
  feed: $('feed'),
  editDialog: $('edit-dialog'),
  editPreview: $('edit-preview'),
  editPrompt: $('edit-prompt'),
  editPromptError: $('edit-prompt-error'),
  editFormError: $('edit-form-error'),
  editBusyNote: $('edit-busy-note'),
  editSubmit: $('edit-submit'),
  editCancel: $('edit-cancel'),
  promptCard: $('prompt-card'),
};

const state = {
  settings: loadSettings(),
  showKey: false,
  busy: null, // null | 'generate' | 'edit': one request at a time
  turns: [], // newest first; in memory only, never persisted
  banner: null, // { title, source, note } for the latest successful turn
  edit: null, // { turn, image, index, opener, sourceBytes } while the edit dialog is open
};

let turnCounter = 0;

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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settingsForStorage(state.settings)));
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

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(stripDataUrlPrefix(String(reader.result)));
    reader.onerror = () => reject(new Error('Không đọc được dữ liệu ảnh'));
    reader.readAsDataURL(blob);
  });
}

function svgIcon(attrs, pathData) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'aria-hidden': 'true', ...attrs })) {
    svg.setAttribute(k, v);
  }
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', pathData);
  svg.appendChild(path);
  return svg;
}

function downloadIconSvg() {
  return svgIcon(
    { width: '16', height: '16', 'stroke-width': '2.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    'M12 3v12M7 10l5 5 5-5M5 21h14',
  );
}

function makeEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const verbFor = (kind) => (kind === 'edit' ? 'Đang chỉnh sửa' : 'Đang tạo');
const KIND_LABELS = { generate: 'Tạo ảnh', reference: 'Tạo ảnh từ ảnh tham chiếu', edit: 'Chỉnh sửa' };

/* ---------- request preview & settings widgets ---------- */

function renderRequestPreview() {
  const { baseUrl, model, prompt, size, n } = state.settings;
  if (attachments.items.length > 0) {
    const lines = [
      `POST ${normalizeBaseUrl(baseUrl)}${EDIT_ENDPOINT_PATH}${n > 1 ? ` (× ${n} request song song)` : ''}`,
      'Authorization: Bearer ••••••••',
      'Content-Type: multipart/form-data',
      '',
      `model = ${buildUpstreamBody({ model, prompt, size, n: 1 }).model}`,
      `prompt = ${prompt.trim() === '' ? '…' : prompt}`,
      `size = ${size}`,
      ...attachments.items.map((item, i) => `image[] = image${i + 1} (${item.type})`),
    ];
    el.requestPreview.textContent = lines.join('\n');
    return;
  }
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

/* ---------- reference image attachments ---------- */

// A picker owns a list of attached images ({ blob, type, size, name, url }) and its thumbnails.
// `baseCount`/`baseBytes` account for images that count toward the limits but are not in the list.
function createPicker({ input, list, error, baseCount = () => 0, baseBytes = () => 0, onChange = () => {} }) {
  const picker = {
    items: [],
    showError(message) {
      error.textContent = message;
      error.hidden = message === '';
    },
    addFiles(files) {
      const accepted = [];
      let message = '';
      for (const file of files) {
        const problem = checkAttachment(
          {
            count: baseCount() + picker.items.length,
            totalBytes: baseBytes() + picker.items.reduce((sum, item) => sum + item.size, 0),
          },
          file,
        );
        if (problem) {
          message = problem;
          continue;
        }
        const item = { blob: file, type: file.type, size: file.size, name: file.name, url: URL.createObjectURL(file) };
        picker.items.push(item);
        accepted.push(item);
      }
      picker.showError(message);
      picker.render();
      if (message) announce(message);
      return accepted;
    },
    // Removes the given items (all when omitted) and frees their thumbnail URLs.
    remove(targets = picker.items) {
      const gone = new Set(targets);
      for (const item of picker.items) if (gone.has(item)) URL.revokeObjectURL(item.url);
      picker.items = picker.items.filter((item) => !gone.has(item));
      picker.render();
    },
    clear() {
      picker.remove();
      picker.showError('');
    },
    render() {
      list.replaceChildren(
        ...picker.items.map((item, i) => {
          const li = makeEl('li', 'attach-item');
          const img = makeEl('img');
          img.alt = `Ảnh đính kèm ${i + 1}`;
          img.src = item.url;
          const remove = makeEl('button', 'attach-remove', '×');
          remove.type = 'button';
          remove.setAttribute('aria-label', `Bỏ ảnh ${i + 1}`);
          remove.addEventListener('click', () => {
            picker.remove([item]);
            picker.showError('');
            input.focus();
          });
          li.append(img, remove);
          return li;
        }),
      );
      onChange();
    },
  };
  input.addEventListener('change', () => {
    picker.addFiles([...input.files]);
    input.value = ''; // allow picking the same file again
  });
  return picker;
}

const imageFilesOf = (dataTransfer) =>
  dataTransfer ? [...dataTransfer.files].filter((file) => file.type.startsWith('image/')) : [];

// Drag-and-drop of image files onto `zone` and pasting images into `field`.
function wireImageIntake(picker, zone, field) {
  zone.addEventListener('dragover', (event) => {
    if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
    event.preventDefault();
    zone.classList.add('drag-over');
  });
  for (const type of ['dragleave', 'dragend']) zone.addEventListener(type, () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', (event) => {
    zone.classList.remove('drag-over');
    const files = imageFilesOf(event.dataTransfer);
    if (files.length === 0) return;
    event.preventDefault();
    picker.addFiles(files);
  });
  field.addEventListener('paste', (event) => {
    const files = imageFilesOf(event.clipboardData);
    if (files.length === 0) return; // plain text paste proceeds as usual
    event.preventDefault();
    picker.addFiles(files);
  });
}

const attachments = createPicker({
  input: $('attach-input'),
  list: $('attach-list'),
  error: $('attach-error'),
  onChange: () => renderRequestPreview(),
});
const editAttachments = createPicker({
  input: $('edit-attach-input'),
  list: $('edit-attach-list'),
  error: $('edit-attach-error'),
  baseCount: () => (state.edit ? 1 : 0),
  baseBytes: () => (state.edit ? state.edit.sourceBytes : 0),
});
wireImageIntake(attachments, el.promptCard, el.prompt);
wireImageIntake(editAttachments, el.editDialog, el.editPrompt);

/* ---------- turns (feed entries) ---------- */

// Builds the DOM of one feed entry once; later changes update it in place so
// running animations and keyboard focus are never disturbed.
function createTurn({ kind, prompt, size, count, thumbs = [], ownedUrls = [], imageCount = 0 }) {
  turnCounter += 1;
  const turn = {
    id: turnCounter,
    kind,
    prompt,
    size,
    count,
    stamp: new Date(),
    status: 'loading', // loading | done | error
    images: [],
    ownedUrls,
    expectedMs: expectedDuration(imageCount),
    frames: [],
    startedAt: 0,
    timer: null,
    percent: 0,
  };

  const root = makeEl('section', 'turn');
  const head = makeEl('div', 'turn-head');
  head.append(makeEl('span', 'turn-kind', KIND_LABELS[kind]));
  const time = makeEl('time', 'turn-time', formatClock(turn.stamp));
  time.dateTime = turn.stamp.toISOString();
  head.appendChild(time);
  turn.downloadAllBtn = makeEl('button', 'ghost-btn');
  turn.downloadAllBtn.type = 'button';
  turn.downloadAllBtn.hidden = true;
  turn.downloadAllBtn.addEventListener('click', () => downloadAll(turn));
  head.appendChild(turn.downloadAllBtn);
  root.appendChild(head);

  const source = makeEl('div', 'turn-source');
  if (thumbs.length > 0) {
    const strip = makeEl('div', 'turn-thumbs');
    thumbs.forEach((src, i) => {
      const thumb = makeEl('img', 'turn-thumb');
      thumb.alt = kind === 'edit' && i === 0 ? 'Ảnh nguồn' : `Ảnh tham chiếu ${kind === 'edit' ? i : i + 1}`;
      thumb.decoding = 'async';
      thumb.src = src;
      strip.appendChild(thumb);
    });
    source.appendChild(strip);
  }
  turn.promptEl = makeEl('p', 'turn-prompt');
  source.appendChild(turn.promptEl);
  root.appendChild(source);

  turn.body = makeEl('div', 'turn-body');
  root.appendChild(turn.body);
  turn.el = root;

  turn.promptEl.textContent = `${verbFor(kind)}: ${prompt}`;
  buildLoadingFrames(turn);
  return turn;
}

function buildLoadingFrames(turn) {
  const grid = makeEl('div', turn.count === 1 ? 'grid single' : 'grid');
  turn.frames = [];
  for (let i = 0; i < turn.count; i++) {
    const frame = makeEl('div', 'frame loading');
    frame.style.aspectRatio = aspectRatio(turn.size);
    frame.setAttribute('role', 'progressbar');
    frame.setAttribute('aria-label', 'Tiến độ ước tính');
    frame.setAttribute('aria-valuemin', '0');
    frame.setAttribute('aria-valuemax', '100');
    frame.setAttribute('aria-valuenow', '0');
    frame.setAttribute('aria-valuetext', '0%');
    const fade = makeEl('div', 'dots-fade');
    fade.append(makeEl('div', 'dots-lit'), makeEl('div', 'glow'));
    const badge = makeEl('span', 'pct-badge', '0%');
    frame.append(makeEl('div', 'dots'), fade, badge);
    grid.appendChild(frame);
    turn.frames.push({ frame, badge });
  }
  turn.body.replaceChildren(grid);
}

function setTurnPercent(turn, percent) {
  if (percent === turn.percent) return;
  turn.percent = percent;
  for (const { frame, badge } of turn.frames) {
    badge.textContent = `${percent}%`;
    frame.setAttribute('aria-valuenow', String(percent));
    frame.setAttribute('aria-valuetext', `${percent}%`);
  }
}

function startProgress(turn) {
  turn.startedAt = performance.now();
  const tick = () => setTurnPercent(turn, estimateProgress(performance.now() - turn.startedAt, turn.expectedMs));
  tick();
  turn.timer = setInterval(tick, PROGRESS_TICK_MS);
}

function stopProgress(turn) {
  if (turn.timer !== null) clearInterval(turn.timer);
  turn.timer = null;
}

function showTurnImages(turn) {
  const total = turn.images.length;
  const grid = makeEl('div', total === 1 ? 'grid single' : 'grid');
  turn.images.forEach((image, index) => {
    const figure = document.createElement('figure');

    const frame = makeEl('button', 'frame done img-btn');
    frame.type = 'button';
    frame.style.aspectRatio = aspectRatio(turn.size);
    frame.setAttribute('aria-label', `Chỉnh sửa ảnh ${index + 1}`);
    frame.addEventListener('click', () => openEditDialog(turn, index, frame));
    const img = document.createElement('img');
    img.alt = '';
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
    frame.appendChild(makeEl('span', 'source-tag', image.kind === 'b64' ? 'b64_json' : 'url'));
    frame.appendChild(makeEl('span', 'edit-hint', 'Chỉnh sửa'));
    figure.appendChild(frame);

    const caption = document.createElement('figcaption');
    const code = makeEl('code', '', makeFilename(turn.stamp, index, total));
    const button = makeEl('button', 'dl-btn');
    button.type = 'button';
    button.appendChild(downloadIconSvg());
    button.appendChild(document.createTextNode('Tải về'));
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await downloadImage(turn, index);
      } finally {
        button.disabled = false;
      }
    });
    caption.append(code, button);
    figure.appendChild(caption);
    grid.appendChild(figure);
  });
  turn.body.replaceChildren(grid);
  turn.promptEl.textContent = turn.prompt;
  if (total > 1) {
    turn.downloadAllBtn.replaceChildren(downloadIconSvg(), document.createTextNode(`Tải tất cả (${total})`));
    turn.downloadAllBtn.hidden = false;
  }
}

function showTurnError(turn, title, body) {
  const box = makeEl('div', 'turn-error');
  box.setAttribute('role', 'alert');
  const head = makeEl('div', 'error-head');
  const badge = makeEl('span', 'badge', '!');
  badge.setAttribute('aria-hidden', 'true');
  const text = makeEl('div', 'banner-text');
  text.append(
    makeEl('div', 'banner-title', title),
    makeEl('div', 'banner-note', 'Nội dung response từ máy chủ:'),
    makeEl('div', 'error-hint', 'Kiểm tra API key, Base URL hoặc model rồi thử lại.'),
  );
  const copy = makeEl('button', 'copy-btn', 'Sao chép');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    const ok = await copyText(body);
    copy.textContent = ok ? 'Đã sao chép' : 'Không sao chép được';
    announce(copy.textContent);
    setTimeout(() => { copy.textContent = 'Sao chép'; }, 2000);
  });
  head.append(badge, text, copy);
  box.append(head, makeEl('pre', '', body));
  turn.body.replaceChildren(box);
  turn.promptEl.textContent = turn.prompt;
}

function removeAllTurns() {
  for (const turn of state.turns) {
    stopProgress(turn);
    for (const url of turn.ownedUrls) URL.revokeObjectURL(url);
    for (const image of turn.images) {
      if (image.blobUrl) URL.revokeObjectURL(image.blobUrl);
    }
  }
  state.turns = [];
  state.banner = null;
  el.feed.replaceChildren();
  clearDownloadError();
}

/* ---------- page-level rendering ---------- */

function render() {
  const busy = state.busy !== null;
  el.generate.disabled = busy;
  el.genSpinner.hidden = !busy;
  el.genLabel.textContent = state.busy === 'edit' ? 'Đang chỉnh sửa…' : busy ? 'Đang tạo ảnh…' : 'Tạo ảnh';

  const hasTurns = state.turns.length > 0;
  el.resultIdle.hidden = hasTurns;
  el.feed.hidden = !hasTurns;
  el.clearAll.hidden = !hasTurns;
  el.clearAll.disabled = busy;

  el.bannerSuccess.hidden = state.banner === null;
  if (state.banner) {
    el.successTitle.textContent = state.banner.title;
    el.successSource.textContent = state.banner.source;
    el.successNote.textContent = state.banner.note;
  }

  el.editSubmit.disabled = busy;
  el.editBusyNote.hidden = !busy;
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

async function ensureBlob(image) {
  if (image.blob) return image.blob;
  if (image.kind === 'b64') {
    image.blob = b64ToBlob(image.src);
    return image.blob;
  }
  const response = await fetch(`/api/fetch-image?url=${encodeURIComponent(image.src)}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  }
  image.blob = await response.blob();
  return image.blob;
}

async function ensureBlobUrl(image) {
  if (image.blobUrl) return image.blobUrl;
  image.blobUrl = URL.createObjectURL(await ensureBlob(image));
  return image.blobUrl;
}

async function downloadImage(turn, index) {
  const image = turn.images[index];
  clearDownloadError();
  try {
    const href = await ensureBlobUrl(image);
    const a = document.createElement('a');
    a.href = href;
    a.download = makeFilename(turn.stamp, index, turn.images.length);
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } catch (err) {
    showDownloadError(`Không tải được ảnh ${index + 1}: ${err.message}`);
    return false;
  }
}

async function downloadAll(turn) {
  turn.downloadAllBtn.disabled = true;
  try {
    for (let i = 0; i < turn.images.length; i++) {
      if (!state.turns.includes(turn)) break;
      await downloadImage(turn, i);
      if (i < turn.images.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_DELAY_MS));
      }
    }
  } finally {
    turn.downloadAllBtn.disabled = false;
  }
}

/* ---------- requests ---------- */

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

// Turns a finished HTTP exchange into { images } or { error: { title, body } }.
function interpretResponse(response, text, failLabel) {
  const status = `HTTP ${response.status}${response.statusText ? ' ' + response.statusText : ''}`;
  if (!response.ok) {
    return { error: { title: `${failLabel} thất bại · ${status}`, body: formatErrorBody(text) } };
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { error: { title: `${failLabel} thất bại · ${status} · Phản hồi không phải JSON`, body: text } };
  }
  const images = extractImages(json);
  if (images.length === 0) {
    return { error: { title: `Phản hồi không chứa ảnh · ${status}`, body: formatErrorBody(text) } };
  }
  try {
    for (const image of images) {
      if (image.kind === 'b64') image.blobUrl = URL.createObjectURL(b64ToBlob(image.src));
    }
  } catch {
    for (const image of images) if (image.blobUrl) URL.revokeObjectURL(image.blobUrl);
    return { error: { title: `${failLabel} thất bại · ${status} · Không giải mã được base64`, body: formatErrorBody(text) } };
  }
  return { images };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs one request as a new feed entry. `send` resolves to { response, text }.
async function runTurn(turn, send) {
  state.turns.unshift(turn);
  el.feed.prepend(turn.el);
  state.busy = turn.kind;
  state.banner = null;
  clearDownloadError();
  startProgress(turn);
  render();
  announce(`${verbFor(turn.kind)}…`);

  const failLabel = turn.kind === 'edit' ? 'Chỉnh sửa ảnh' : 'Tạo ảnh';
  let ok = false;
  const started = performance.now();
  let outcome;
  try {
    const { response, text } = await send();
    outcome = interpretResponse(response, text, failLabel);
  } catch (err) {
    outcome = {
      error: {
        title: 'Lỗi kết nối',
        body: formatErrorBody(JSON.stringify({ error: { message: (err && err.message) || String(err) } })),
      },
    };
  }
  const elapsed = performance.now() - started;
  stopProgress(turn);

  try {
    if (outcome.images) {
      setTurnPercent(turn, 100);
      await wait(PROGRESS_DONE_HOLD_MS);
      turn.images = outcome.images;
      turn.status = 'done';
      showTurnImages(turn);
      const total = turn.images.length;
      state.banner = {
        title: turn.kind === 'edit'
          ? `Đã chỉnh sửa ảnh · ${formatElapsed(elapsed)} giây`
          : `Đã tạo ${total} ảnh · ${formatElapsed(elapsed)} giây`,
        source: describeSource(turn.images),
        note: sourceNote(turn.images),
      };
      ok = true;
      announce(turn.kind === 'edit'
        ? `Đã chỉnh sửa ảnh trong ${formatElapsed(elapsed)} giây`
        : `Đã tạo ${total} ảnh trong ${formatElapsed(elapsed)} giây`);
    } else {
      turn.status = 'error';
      showTurnError(turn, outcome.error.title, outcome.error.body);
      announce(outcome.error.title);
    }
  } finally {
    state.busy = null;
    render();
  }
  return ok;
}

function sourceNote(images) {
  const source = describeSource(images);
  if (source === 'b64_json') return 'đã giải mã base64';
  if (source === 'url') return 'tải ảnh từ URL máy chủ trả về';
  return 'đã giải mã base64 và tải ảnh từ URL';
}

async function generate() {
  if (state.busy) return;
  if (!validate()) return;
  const { baseUrl, apiKey, model, prompt, size, n } = state.settings;
  if (attachments.items.length > 0) {
    const sent = [...attachments.items];
    const turnUrls = sent.map((item) => URL.createObjectURL(item.blob));
    const turn = createTurn({
      kind: 'reference', prompt, size, count: n, thumbs: turnUrls, ownedUrls: turnUrls, imageCount: sent.length,
    });
    const ok = await runTurn(turn, async () => {
      const images = await Promise.all(sent.map((item) => blobToBase64(item.blob)));
      return postJson('/api/edit', { baseUrl, apiKey: apiKey.trim(), model: model.trim(), prompt, size, n, images });
    });
    if (ok) attachments.remove(sent); // kept on error so the visitor can retry
    return;
  }
  const turn = createTurn({ kind: 'generate', prompt, size, count: n });
  await runTurn(turn, () => postJson('/api/generate', { baseUrl, apiKey: apiKey.trim(), model: model.trim(), prompt, size, n }));
}

async function postJson(path, payload) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { response, text: await response.text() };
}

/* ---------- edit dialog ---------- */

function clearEditErrors() {
  for (const node of [el.editPromptError, el.editFormError]) {
    node.hidden = true;
    node.textContent = '';
  }
  el.editPrompt.removeAttribute('aria-invalid');
}

function openEditDialog(turn, index, opener) {
  const image = turn.images[index];
  state.edit = { turn, image, index, opener, sourceBytes: image.kind === 'b64' ? Math.floor((image.src.length * 3) / 4) : 0 };
  editAttachments.clear();
  clearEditErrors();
  el.editPrompt.value = '';
  el.editPreview.src = state.edit.image.blobUrl || state.edit.image.src;
  render();
  el.editDialog.showModal();
  el.editPrompt.focus();
}

function closeEditDialog() {
  if (el.editDialog.open) el.editDialog.close();
}

function submitEdit() {
  if (!state.edit || state.busy) return;
  clearEditErrors();
  const text = el.editPrompt.value;
  if (text.trim() === '') {
    el.editPromptError.textContent = 'Vui lòng nhập mô tả chỉnh sửa.';
    el.editPromptError.hidden = false;
    el.editPrompt.setAttribute('aria-invalid', 'true');
    el.editPrompt.focus();
    return;
  }
  const { baseUrl, apiKey, model, size } = state.settings;
  if (apiKey.trim() === '') {
    el.editFormError.textContent = 'Vui lòng nhập API key ở mục Kết nối.';
    el.editFormError.hidden = false;
    return;
  }
  const { image } = state.edit;
  const extras = [...editAttachments.items];
  closeEditDialog(); // focus returns to the image button via the close handler
  const extraUrls = extras.map((item) => URL.createObjectURL(item.blob));
  const turn = createTurn({
    kind: 'edit',
    prompt: text,
    size,
    count: 1,
    thumbs: [image.blobUrl || image.src, ...extraUrls],
    ownedUrls: extraUrls,
    imageCount: 1 + extras.length,
  });
  runTurn(turn, async () => {
    const first = image.kind === 'b64' ? image.src : await blobToBase64(await ensureBlob(image));
    const rest = await Promise.all(extras.map((item) => blobToBase64(item.blob)));
    return postJson('/api/edit', { baseUrl, apiKey: apiKey.trim(), model: model.trim(), prompt: text, size, images: [first, ...rest] });
  });
}

el.editSubmit.addEventListener('click', submitEdit);
el.editCancel.addEventListener('click', closeEditDialog);
el.editPrompt.addEventListener('input', () => {
  if (el.editPrompt.value.trim() !== '') {
    el.editPromptError.hidden = true;
    el.editPrompt.removeAttribute('aria-invalid');
  }
});
el.editPrompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    submitEdit();
  }
});
el.editDialog.addEventListener('click', (event) => {
  if (event.target === el.editDialog) closeEditDialog(); // click on the backdrop
});
el.editDialog.addEventListener('close', () => {
  const opener = state.edit && state.edit.opener;
  state.edit = null;
  editAttachments.clear();
  if (opener && opener.isConnected) opener.focus();
});

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
el.rememberKey.addEventListener('change', () => update({ rememberKey: el.rememberKey.checked }));
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
  state.banner = null;
  render();
});
el.clearAll.addEventListener('click', () => {
  if (state.busy) return;
  removeAllTurns();
  render();
  announce('Đã xoá tất cả kết quả');
});

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
el.rememberKey.checked = state.settings.rememberKey;
saveSettings(); // scrubs any API key stored before the opt-in existed
el.model.value = state.settings.model;
el.prompt.value = state.settings.prompt;
renderRequestPreview();
renderChoices();
renderKeyToggle();
render();
