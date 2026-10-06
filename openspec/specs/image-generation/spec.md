# image-generation Specification

## Purpose
Lets a user generate images through an OpenAI-compatible images endpoint from a local web UI, view the results, and save them as PNG files.

## Requirements

### Requirement: Connection settings
The UI SHALL provide inputs for Base URL, API key and model. Base URL SHALL default to `https://bedrock.viber.vn` and model to `gpt-image-2-5`. The request endpoint SHALL be the Base URL after trimming whitespace, removing trailing `/` characters and removing a trailing `/v1/images/generations` (case-insensitive), followed by `/v1/images/generations`. An empty Base URL SHALL fall back to the default. The API key input SHALL be masked by default with an accessible toggle button to show/hide it.

#### Scenario: Suffix appended
- **WHEN** Base URL is `https://bedrock.viber.vn`
- **THEN** the endpoint used is `https://bedrock.viber.vn/v1/images/generations`

#### Scenario: Trailing slash and full path normalized
- **WHEN** Base URL is ` https://bedrock.viber.vn/v1/images/generations/ `
- **THEN** the endpoint is `https://bedrock.viber.vn/v1/images/generations` (no duplicated suffix)

#### Scenario: Empty base URL
- **WHEN** Base URL is empty or whitespace
- **THEN** the endpoint is `https://bedrock.viber.vn/v1/images/generations`

#### Scenario: Toggle key visibility
- **WHEN** the user activates the show/hide button
- **THEN** the key input switches between masked and plain text and the button's accessible label switches between "Hiện API key" and "Ẩn API key"

### Requirement: Settings persistence
The app SHALL persist Base URL, model, prompt, size, n and the "remember key" choice in browser localStorage on change and restore them on load. The API key SHALL be written to localStorage only while the checkbox "Ghi nhớ API key trên trình duyệt này" (default unchecked, shown under the API key field) is checked; otherwise the key SHALL stay in memory only and any key previously stored SHALL be removed from localStorage on load and when the box is unchecked. A visible note "Key chỉ được gửi tới API qua máy chủ này, không được lưu hay ghi log." SHALL appear under the key field. If storage is unavailable or holds invalid values, the app SHALL use defaults without failing.

#### Scenario: Restore after reload
- **WHEN** the user changes model to `x-model` and reloads the page
- **THEN** the model input shows `x-model`

#### Scenario: Corrupt stored value
- **WHEN** localStorage holds a non-JSON or out-of-range value (e.g. n = 9)
- **THEN** defaults are used for those fields (n = 1)

#### Scenario: Key not remembered by default
- **WHEN** the user types an API key without checking "Ghi nhớ API key trên trình duyệt này" and reloads the page
- **THEN** the key field is empty and localStorage contains no API key

#### Scenario: Key remembered on opt-in
- **WHEN** the user checks the box, types an API key and reloads the page
- **THEN** the key field is restored and the box is still checked

#### Scenario: Opting out clears the stored key
- **WHEN** a key was stored and the user unchecks the box
- **THEN** the key is removed from localStorage while remaining in the field for the current page

### Requirement: Request parameters
The UI SHALL provide a prompt textarea, a size choice among `1024x1024`, `1536x1024`, `1024x1536`, `auto` (default `1024x1024`), and an n choice among 1–4 (default 1). Choices SHALL be buttons exposing `aria-pressed`.

#### Scenario: Request body
- **WHEN** the user generates with model `gpt-image-2-5`, prompt `cat`, size `1536x1024`, n 2
- **THEN** the local server sends 2 upstream requests, each with body `{"model":"gpt-image-2-5","prompt":"cat","size":"1536x1024","n":1}` and headers `Authorization: Bearer <key>` and `Content-Type: application/json`, and the response data arrays are merged in order into one result

#### Scenario: Partial failure
- **WHEN** n is 3 and at least one upstream request fails (non-200 status)
- **THEN** the first failing upstream status, content type and body are returned verbatim and no images are shown; a network failure of any request yields 502 JSON

### Requirement: Input validation
Generation SHALL NOT send a request when the prompt (trimmed) or API key (trimmed) is empty; the app SHALL show an inline message next to the offending field and move focus to it.

#### Scenario: Empty prompt
- **WHEN** the prompt is empty and the user clicks "Tạo ảnh"
- **THEN** no request is sent and the message "Vui lòng nhập prompt." is shown under the prompt

#### Scenario: Empty API key
- **WHEN** the API key is empty and the user clicks "Tạo ảnh"
- **THEN** no request is sent and the message "Vui lòng nhập API key." is shown under the key

### Requirement: Generate action and states
The result area SHALL show an idle message while the session feed is empty and the feed otherwise. While any request (generate or edit) is running, the generate button SHALL be disabled, show a spinner and the label "Đang tạo ảnh…" (or "Đang chỉnh sửa…" for an edit), the edit submit button SHALL be disabled, and the new feed entry SHALL show one animated placeholder per requested image. Only one request SHALL run at a time. Ctrl+Enter (or Cmd+Enter) inside the prompt SHALL trigger generation. Status changes SHALL be announced via an `aria-live="polite"` region.

#### Scenario: Loading
- **WHEN** a valid request is in flight
- **THEN** the button is disabled and a second click or Ctrl+Enter sends no additional request

#### Scenario: Keyboard shortcut
- **WHEN** focus is in the prompt and the user presses Ctrl+Enter
- **THEN** generation starts exactly as if the button were clicked

#### Scenario: One request at a time
- **WHEN** an edit request is running
- **THEN** the generate button and the edit submit button are disabled

### Requirement: Result rendering
On a 2xx response the app SHALL read every item in `data`. An item with `b64_json` SHALL be rendered as a PNG from the base64 payload; if the value starts with `data:` the part up to and including the first `,` SHALL be removed first. Otherwise an item with `url` SHALL be rendered from that URL. Items with neither SHALL be skipped. Results SHALL be rendered inside the session feed (see "Session result feed"). The success banner SHALL describe the latest finished turn: the number of images (or "Đã chỉnh sửa ảnh" for an edit), elapsed seconds (one decimal, comma separator) and the source field (`b64_json` or `url`, or both). Each rendered image SHALL be a `<button>` (see "Edit an image").

#### Scenario: Plain b64_json
- **WHEN** the response is the sample in `response.txt`
- **THEN** one image is shown and the banner says "Đã tạo 1 ảnh" with source `b64_json`

#### Scenario: Prefixed b64_json
- **WHEN** `data[0].b64_json` is `data:image/png;base64,iVBOR...`
- **THEN** the image is rendered from `iVBOR...`

#### Scenario: URL result
- **WHEN** `data[0]` has only `url`
- **THEN** the image is displayed from that URL and the source shown is `url`

#### Scenario: Success without images
- **WHEN** the response is 2xx but contains no usable item
- **THEN** the turn shows an error block with the message "Phản hồi không chứa ảnh" and the raw body

### Requirement: Error display
On a non-2xx response, an unparseable 2xx body, or a network failure, the app SHALL show an error block inside the failing feed turn (earlier turns stay) with the HTTP status (code and reason, or "Lỗi kết nối" for network failure) and the raw response body; if the body is valid JSON it SHALL be pretty-printed with 2-space indentation. A "Sao chép" button SHALL copy the body to the clipboard and confirm with "Đã sao chép".

#### Scenario: Unauthorized
- **WHEN** upstream returns 401 with `{"error":{"message":"Incorrect API key provided."}}`
- **THEN** the turn's error block shows "HTTP 401" and the pretty-printed JSON

#### Scenario: Upstream unreachable
- **WHEN** the upstream host cannot be reached
- **THEN** the local server responds 502 with `{"error":{"message":"<reason>"}}` and the UI shows the error block in that turn with that body

### Requirement: Download images
Each image SHALL have a "Tải về" control saving it as `img_YYYYMMDD_HHMMSS.png` using the local time when that turn's response arrived. When the turn holds more than one image, filenames SHALL be `img_YYYYMMDD_HHMMSS_<i>.png` with i from 1. A turn holding more than one image SHALL have a "Tải tất cả" control downloading all of that turn's images. URL images SHALL be fetched through the local server so the download works regardless of CORS; a failed fetch SHALL show an error message without clearing results.

#### Scenario: Single image name
- **WHEN** one image arrives at 2026-10-06 14:30:22 local time
- **THEN** it downloads as `img_20261006_143022.png`

#### Scenario: Multiple images
- **WHEN** three images arrive at that time
- **THEN** they download as `img_20261006_143022_1.png`, `_2.png`, `_3.png`

### Requirement: Local proxy server
A local server SHALL serve the UI and expose `POST /api/generate`, `POST /api/edit` and `GET /api/fetch-image`. `/api/generate` SHALL accept JSON `{baseUrl, apiKey, model, prompt, size, n}`, forward to the normalized endpoint, and return the upstream status, content type and body unchanged. `/api/fetch-image?url=` SHALL accept only `http:`/`https:` URLs (400 otherwise) and stream the image bytes with the upstream content type. `/api/generate` request bodies over 1 MB, and `/api/edit` request bodies over 30 MB, SHALL be rejected with 413. The server SHALL bind to `HOST` (default `127.0.0.1`) on `PORT` (default 5173). Every response SHALL carry `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and a `Content-Security-Policy` of `default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, and every `/api/*` response SHALL carry `Cache-Control: no-store`. The UI SHALL work under that policy (no inline scripts, style attributes or event handler attributes). `/api/fetch-image` SHALL refuse responses larger than 50 MB. Upstream redirects SHALL NOT be followed: a 3xx upstream response SHALL yield 502 JSON.

#### Scenario: Invalid fetch URL
- **WHEN** `/api/fetch-image?url=file:///etc/passwd` is requested
- **THEN** the server responds 400

#### Scenario: Status passthrough
- **WHEN** upstream returns 429 with a text body
- **THEN** `/api/generate` responds 429 with the same body

#### Scenario: Security headers
- **WHEN** any path (static, API or error) is requested
- **THEN** the response includes the Content-Security-Policy, Referrer-Policy, X-Content-Type-Options and X-Frame-Options headers above, and `/api/*` responses also include `Cache-Control: no-store`

#### Scenario: Redirect not followed
- **WHEN** the upstream answers with a 302 redirect
- **THEN** the server responds 502 and never requests the redirect target

#### Scenario: Oversized image
- **WHEN** `/api/fetch-image` targets a response larger than 50 MB
- **THEN** the server responds 413 when the size is declared, or aborts the transfer once 50 MB is exceeded

### Requirement: Estimated progress indicator
While a request is running, each placeholder frame SHALL show an animated dot grid (round dots on a regular grid of about 12 px filling the frame at the aspect ratio of the chosen size) with a soft accent-coloured glow band sweeping across it and fading toward the edges, in a theme-appropriate dim frame (near-black in dark theme). A pill in the bottom-right corner SHALL show an estimated percentage "NN%". Because the upstream reports no progress, the percentage SHALL be time-based: it SHALL be monotonic, ease toward 95 % over an expected duration and never reach 100 % before the response arrives; the expected duration SHALL be 60 s for a request without images, 70 s for an edit or reference-image request with up to 2 images, plus 15 s for each further image. When the response arrives the pill SHALL show 100 % briefly before the images replace the frame. The prompt line SHALL be shown above the frames as "Đang tạo: <prompt>" or "Đang chỉnh sửa: <prompt>". Each frame SHALL expose `role="progressbar"`, `aria-valuemin`/`aria-valuemax`, an updated `aria-valuenow` and the label "Tiến độ ước tính". With `prefers-reduced-motion: reduce` the dots SHALL be static while the percentage still updates.

#### Scenario: Progress is an estimate
- **WHEN** a request has run for 30 s of an expected 60 s
- **THEN** the pill shows a value between 40 % and 90 % and `aria-valuenow` equals that value

#### Scenario: Never 100 before the response
- **WHEN** a request runs far longer than the expected duration
- **THEN** the pill never exceeds 95 % until the response arrives

#### Scenario: Completion
- **WHEN** the response arrives with images
- **THEN** the pill shows 100 % briefly and then the images replace the placeholder

#### Scenario: Reduced motion
- **WHEN** the visitor prefers reduced motion
- **THEN** the dots do not animate and the percentage still updates

### Requirement: Edit an image
Each rendered result image SHALL be a real `<button>` with accessible name "Chỉnh sửa ảnh N" (N from 1 within its turn). Activating it (click, Enter or Space) SHALL open a modal native `<dialog>` showing the image, a required textarea labelled "Mô tả chỉnh sửa" with inline validation, optional extra reference images (see below) and the buttons "Chỉnh sửa" and "Huỷ". Esc or "Huỷ" SHALL close the dialog and return focus to the image button. Submitting SHALL send the image (base64 from the response, or for a URL image the bytes fetched through `/api/fetch-image`) as the first image, followed by any extra reference images, with the dialog prompt and the current Base URL, API key, model and size to `POST /api/edit` with `n` = 1, and add an edit turn to the feed. The dialog SHALL accept up to 3 extra reference images (4 images in total, each ≤ 20 MB, total within the request limit) through a file picker (`accept="image/png,image/jpeg,image/webp"`, multiple), drag-and-drop and paste, show thumbnails with "Bỏ ảnh N" remove buttons, and reject others with an inline message. The edit submit button SHALL be disabled while any request runs.

#### Scenario: Open and cancel
- **WHEN** the user presses Enter on a focused result image and then Esc
- **THEN** the dialog opens and closes and focus returns to that image

#### Scenario: Empty description
- **WHEN** the user submits with an empty description
- **THEN** no request is sent and the message "Vui lòng nhập mô tả chỉnh sửa." is shown

#### Scenario: Edit request
- **WHEN** the user submits "make it blue" for image 1
- **THEN** `/api/edit` receives that image and prompt, and a new "Chỉnh sửa" turn with the source thumbnail appears first in the feed

#### Scenario: Extra reference images
- **WHEN** the user attaches 2 extra images in the dialog and submits
- **THEN** the request carries 3 images with the clicked image first, and the turn header shows all 3 thumbnails

#### Scenario: Too many images
- **WHEN** the dialog already holds the clicked image plus 3 extras and another is added
- **THEN** it is rejected with an inline message

### Requirement: Reference images on create
Under the prompt the create form SHALL offer "Đính kèm ảnh": a styled label for a real `<input type="file" accept="image/png,image/jpeg,image/webp" multiple>`, plus drag-and-drop onto the prompt card and paste from the clipboard into the prompt textarea. At most 4 images SHALL be attached, each ≤ 20 MB and all together small enough that the base64 request stays within 30 MB; other files SHALL be rejected with an inline message. Attached images SHALL be shown as thumbnails with remove buttons labelled "Bỏ ảnh N". With at least one image attached, "Tạo ảnh" SHALL send the images and prompt to `POST /api/edit` (with `n` from the settings, fanned out by the server), the feed turn SHALL be labelled "Tạo ảnh từ ảnh tham chiếu" and show the reference thumbnails; with none attached it SHALL use `/api/generate` as before. Attachments SHALL be cleared after a successful request, kept after an error, and never persisted.

#### Scenario: Attach and generate
- **WHEN** the user attaches 2 images, enters a prompt and presses "Tạo ảnh"
- **THEN** one request with both images goes to `/api/edit` and the new turn shows both thumbnails

#### Scenario: Limits
- **WHEN** the user attaches a fifth image, a GIF, or an image over 20 MB
- **THEN** it is rejected with an inline message and nothing is attached

#### Scenario: Kept on error
- **WHEN** the request fails
- **THEN** the attachments remain so the visitor can retry

#### Scenario: Paste
- **WHEN** the user pastes an image from the clipboard into the prompt
- **THEN** the image is attached and no text is inserted

### Requirement: Session result feed
Results SHALL be kept in an in-memory session feed, newest turn first, and SHALL NOT be persisted (no localStorage, IndexedDB or server storage). Each turn SHALL show a header with its kind ("Tạo ảnh", "Tạo ảnh từ ảnh tham chiếu" or "Chỉnh sửa"), the prompt text and the local time, then its images each with the download control and filename convention above (using that turn's time). A turn with source images SHALL show small thumbnails of them. A failed turn SHALL show its error (status, raw body, "Sao chép") inside the turn without removing earlier turns. A "Xoá tất cả" button in the result card header SHALL remove every turn and revoke their blob URLs; blob URLs SHALL NOT be revoked otherwise. "Xoá tất cả" SHALL be disabled while a request runs.

#### Scenario: Newest first
- **WHEN** the user generates and then edits an image
- **THEN** the edit turn appears above the generate turn and the earlier images stay downloadable

#### Scenario: Error keeps history
- **WHEN** a later request fails
- **THEN** the failing turn shows the error and earlier turns are unchanged

#### Scenario: Clear all
- **WHEN** the user activates "Xoá tất cả"
- **THEN** all turns disappear and the idle message is shown

### Requirement: Edit proxy endpoint
`POST /api/edit` SHALL accept JSON `{baseUrl, apiKey, model, prompt, size, images, n}` (or the single-image field `image`) with a body cap of 30 MB (413 beyond). `images` SHALL hold 1 to 4 base64 strings, each optionally prefixed with `data:...,`; anything else (missing apiKey, prompt or images, more than 4 images, invalid base64, or content that is not PNG, JPEG or WEBP by magic bytes) SHALL yield 400 JSON. The server SHALL build a `multipart/form-data` request with fields `model` (default when empty), `prompt`, `size` (when given) and one `image[]` file part per image in order, each with its detected content type and a filename (`image1.png`, …), and POST it to the normalized Base URL followed by `/v1/images/edits` with `Authorization: Bearer <key>`. `n` SHALL NOT be forwarded; for `n` between 2 and 4 the server SHALL send that many concurrent single-image upstream requests and merge their `data` arrays like `/api/generate`. The upstream status, content type and body SHALL be returned unchanged for a single request (first failure verbatim when fanned out), redirects SHALL NOT be followed (502), network failures SHALL give a redacted 502, the upstream address restrictions SHALL apply, nothing SHALL be logged, and responses SHALL carry `Cache-Control: no-store`.

#### Scenario: Multipart forwarding
- **WHEN** a valid request with one PNG image arrives
- **THEN** the upstream receives `POST /v1/images/edits` with fields model, prompt, size and a PNG `image[]` part, and no `n` field

#### Scenario: Several images
- **WHEN** a request carries a PNG, a JPEG and a WEBP
- **THEN** the upstream receives three `image[]` parts in that order with content types image/png, image/jpeg and image/webp

#### Scenario: Fan-out
- **WHEN** `n` is 2
- **THEN** two upstream requests are sent, each with the same images, and the results are merged in one response

#### Scenario: Rejections
- **WHEN** the request has no prompt, no image, five images, invalid base64 or non-image bytes
- **THEN** the server answers 400 and sends no upstream request

#### Scenario: Oversized body
- **WHEN** the body exceeds 30 MB
- **THEN** the server answers 413

#### Scenario: Blocked upstream
- **WHEN** Base URL points to a private or loopback address
- **THEN** the server answers 400 and sends no upstream request

### Requirement: Privacy: no collection of credentials
The server SHALL NOT collect, store or log visitors' API keys, Base URLs or prompts: it SHALL NOT write them to files, stdout, stderr or any console, and SHALL NOT include them (or the full upstream URL) in its own error messages; credential-bearing text and URLs SHALL be redacted from 502 messages. The only output at startup SHALL be the listening address. Credentials SHALL be used only for the single forwarded upstream request.

#### Scenario: Nothing logged
- **WHEN** requests are made (success, 502, 400) with a distinctive API key and prompt
- **THEN** none of the key, prompt or base URL appears in anything written to stdout, stderr or the console

#### Scenario: Errors do not echo secrets
- **WHEN** the upstream fetch fails with an error whose text contains the API key and the full upstream URL
- **THEN** the 502 message contains neither

### Requirement: Upstream address restrictions
`/api/generate`, `/api/edit` and `/api/fetch-image` SHALL accept only `http:`/`https:` URLs without userinfo (`user:pass@`) and SHALL resolve the hostname and reject with 400 JSON any URL where any resolved address is loopback, private (10/8, 172.16/12, 192.168/16), link-local (169.254/16 including cloud metadata), CGNAT (100.64/10), `0.0.0.0/8`, multicast or reserved, IPv6 `::1`, `fc00::/7`, `fe80::/10`, multicast, or an IPv4-mapped form of those. These checks SHALL always be on; no environment variable or runtime setting SHALL disable them.

#### Scenario: Internal address blocked
- **WHEN** Base URL is `http://169.254.169.254`, `http://127.0.0.1`, `http://[::1]` or `http://[::ffff:10.0.0.1]`
- **THEN** the server responds 400 and sends no upstream request

#### Scenario: Hostname resolving to a private address
- **WHEN** a hostname resolves to at least one private address
- **THEN** the server responds 400

#### Scenario: Userinfo rejected
- **WHEN** the URL is `https://user:pass@example.com`
- **THEN** the server responds 400

#### Scenario: Check cannot be disabled
- **WHEN** the server runs with `ALLOW_PRIVATE_UPSTREAM=1` (or any other environment) and Base URL is `http://127.0.0.1:9000`
- **THEN** the server responds 400 and sends no upstream request

### Requirement: Docker deployment
The project SHALL include a `Dockerfile`, a `.dockerignore` and a `compose.yaml` so the app runs with `docker compose up -d`. The image SHALL be based on an official Node.js LTS Alpine image, contain only the runtime files (`package.json`, `server.js`, `public/`), run as the non-root `node` user, set `HOST=0.0.0.0` and `PORT=5173`, expose port 5173 and define a HEALTHCHECK that requests `/` and fails on a non-2xx response. `compose.yaml` SHALL publish the port as `${BIND:-0.0.0.0}:${PORT:-5173}:5173` (reachable on the server's public address by default; `BIND=127.0.0.1` restricts it to the host) and use `restart: unless-stopped`. The image SHALL NOT contain `response.txt`, `test/`, `openspec/`, `.env` files or any API key.

#### Scenario: Run with compose
- **WHEN** the user runs `docker compose up -d --build` and opens `http://localhost:5173`
- **THEN** the UI loads and generation works exactly as when run with `npm start`

#### Scenario: Health
- **WHEN** the container has started
- **THEN** `docker inspect` reports health status `healthy`

#### Scenario: Image contents
- **WHEN** the image filesystem is listed under the app directory
- **THEN** it contains `package.json`, `server.js` and `public/` only, and the process runs as user `node`

#### Scenario: Custom host port
- **WHEN** the user runs `PORT=8080 docker compose up -d`
- **THEN** the app is reachable at `http://localhost:8080` and on the server's public address at port 8080

#### Scenario: Restrict to host
- **WHEN** the user runs `BIND=127.0.0.1 docker compose up -d`
- **THEN** the app is reachable only from the server itself

### Requirement: Light and dark theme
The UI SHALL offer a light and a dark theme with identical layout, each meeting WCAG AA text contrast. With no stored choice the theme SHALL follow the operating system's `prefers-color-scheme` and update live when it changes. A header toggle button (accessible label "Chuyển sang giao diện sáng" / "Chuyển sang giao diện tối", `aria-pressed` true when dark) SHALL switch themes and persist the choice in localStorage; a stored choice overrides the OS setting. The theme SHALL be applied before first paint (no flash). Unavailable storage SHALL fall back to the OS setting without errors.

#### Scenario: Follow OS
- **WHEN** no choice is stored and the OS prefers light
- **THEN** the light theme is shown

#### Scenario: Persist choice
- **WHEN** the user switches to dark and reloads the page
- **THEN** the dark theme is shown regardless of the OS setting

### Requirement: HTTPS deployment
The project SHALL include `compose.https.yaml`, used together with `compose.yaml`, that runs a Caddy reverse proxy terminating TLS for the domain given in the `DOMAIN` environment variable, publishes ports 80 and 443, forwards to the app over the Compose network, and does not publish the app's port 5173. The domain SHALL NOT be hard-coded in the repository; starting without `DOMAIN` SHALL fail with an explanatory message.

#### Scenario: HTTPS on a domain
- **WHEN** DNS for `DOMAIN` points to the server and the user runs `docker compose -f compose.yaml -f compose.https.yaml up -d --build`
- **THEN** `https://<DOMAIN>` serves the app with a valid certificate and `http://<DOMAIN>` redirects to HTTPS

#### Scenario: Missing domain
- **WHEN** `DOMAIN` is unset
- **THEN** `docker compose` refuses to start and names the missing variable
