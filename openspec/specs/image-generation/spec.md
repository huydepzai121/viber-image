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
The result area SHALL have states idle, loading, success and error. While loading, the generate button SHALL be disabled, show a spinner and the label "Đang tạo ảnh…", and the result area SHALL show n placeholders. Ctrl+Enter (or Cmd+Enter) inside the prompt SHALL trigger generation. Status changes SHALL be announced via an `aria-live="polite"` region.

#### Scenario: Loading
- **WHEN** a valid request is in flight
- **THEN** the button is disabled and a second click or Ctrl+Enter sends no additional request

#### Scenario: Keyboard shortcut
- **WHEN** focus is in the prompt and the user presses Ctrl+Enter
- **THEN** generation starts exactly as if the button were clicked

### Requirement: Result rendering
On a 2xx response the app SHALL read every item in `data`. An item with `b64_json` SHALL be rendered as a PNG from the base64 payload; if the value starts with `data:` the part up to and including the first `,` SHALL be removed first. Otherwise an item with `url` SHALL be rendered from that URL. Items with neither SHALL be skipped. The success banner SHALL show the number of images, elapsed seconds (one decimal, comma separator) and the source field (`b64_json` or `url`, or both).

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
- **THEN** the error state is shown with the message "Phản hồi không chứa ảnh" and the raw body

### Requirement: Error display
On a non-2xx response, an unparseable 2xx body, or a network failure, the app SHALL show an error banner with the HTTP status (code and reason, or "Lỗi kết nối" for network failure) and the raw response body; if the body is valid JSON it SHALL be pretty-printed with 2-space indentation. A "Sao chép" button SHALL copy the body to the clipboard and confirm with "Đã sao chép".

#### Scenario: Unauthorized
- **WHEN** upstream returns 401 with `{"error":{"message":"Incorrect API key provided."}}`
- **THEN** the banner shows "HTTP 401" and the pretty-printed JSON

#### Scenario: Upstream unreachable
- **WHEN** the upstream host cannot be reached
- **THEN** the local server responds 502 with `{"error":{"message":"<reason>"}}` and the UI shows the error banner with that body

### Requirement: Download images
Each image SHALL have a "Tải về" control saving it as `img_YYYYMMDD_HHMMSS.png` using the local time when the response arrived. When the response holds more than one image, filenames SHALL be `img_YYYYMMDD_HHMMSS_<i>.png` with i from 1. A "Tải tất cả" control SHALL download every image. URL images SHALL be fetched through the local server so the download works regardless of CORS; a failed fetch SHALL show an error message without clearing results.

#### Scenario: Single image name
- **WHEN** one image arrives at 2026-10-06 14:30:22 local time
- **THEN** it downloads as `img_20261006_143022.png`

#### Scenario: Multiple images
- **WHEN** three images arrive at that time
- **THEN** they download as `img_20261006_143022_1.png`, `_2.png`, `_3.png`

### Requirement: Local proxy server
A local server SHALL serve the UI and expose `POST /api/generate` and `GET /api/fetch-image`. `/api/generate` SHALL accept JSON `{baseUrl, apiKey, model, prompt, size, n}`, forward to the normalized endpoint, and return the upstream status, content type and body unchanged. `/api/fetch-image?url=` SHALL accept only `http:`/`https:` URLs (400 otherwise) and stream the image bytes with the upstream content type. Request bodies over 1 MB SHALL be rejected with 413. The server SHALL bind to `HOST` (default `127.0.0.1`) on `PORT` (default 5173). Every response SHALL carry `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and a `Content-Security-Policy` of `default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, and every `/api/*` response SHALL carry `Cache-Control: no-store`. The UI SHALL work under that policy (no inline scripts, style attributes or event handler attributes). `/api/fetch-image` SHALL refuse responses larger than 50 MB. Upstream redirects SHALL NOT be followed: a 3xx upstream response SHALL yield 502 JSON.

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

### Requirement: Privacy: no collection of credentials
The server SHALL NOT collect, store or log visitors' API keys, Base URLs or prompts: it SHALL NOT write them to files, stdout, stderr or any console, and SHALL NOT include them (or the full upstream URL) in its own error messages; credential-bearing text and URLs SHALL be redacted from 502 messages. The only output at startup SHALL be the listening address. Credentials SHALL be used only for the single forwarded upstream request.

#### Scenario: Nothing logged
- **WHEN** requests are made (success, 502, 400) with a distinctive API key and prompt
- **THEN** none of the key, prompt or base URL appears in anything written to stdout, stderr or the console

#### Scenario: Errors do not echo secrets
- **WHEN** the upstream fetch fails with an error whose text contains the API key and the full upstream URL
- **THEN** the 502 message contains neither

### Requirement: Upstream address restrictions
`/api/generate` and `/api/fetch-image` SHALL accept only `http:`/`https:` URLs without userinfo (`user:pass@`) and SHALL resolve the hostname and reject with 400 JSON any URL where any resolved address is loopback, private (10/8, 172.16/12, 192.168/16), link-local (169.254/16 including cloud metadata), CGNAT (100.64/10), `0.0.0.0/8`, multicast or reserved, IPv6 `::1`, `fc00::/7`, `fe80::/10`, multicast, or an IPv4-mapped form of those. Setting the environment variable `ALLOW_PRIVATE_UPSTREAM=1` SHALL disable the address check (for local use) but not the userinfo check or the no-redirect rule.

#### Scenario: Internal address blocked
- **WHEN** Base URL is `http://169.254.169.254`, `http://127.0.0.1`, `http://[::1]` or `http://[::ffff:10.0.0.1]` and `ALLOW_PRIVATE_UPSTREAM` is not set
- **THEN** the server responds 400 and sends no upstream request

#### Scenario: Hostname resolving to a private address
- **WHEN** a hostname resolves to at least one private address
- **THEN** the server responds 400

#### Scenario: Userinfo rejected
- **WHEN** the URL is `https://user:pass@example.com`
- **THEN** the server responds 400, with or without `ALLOW_PRIVATE_UPSTREAM`

#### Scenario: Local development
- **WHEN** `ALLOW_PRIVATE_UPSTREAM=1` and Base URL is `http://127.0.0.1:9000`
- **THEN** the request is forwarded

### Requirement: Docker deployment
The project SHALL include a `Dockerfile`, a `.dockerignore` and a `compose.yaml` so the app runs with `docker compose up -d`. The image SHALL be based on an official Node.js LTS Alpine image, contain only the runtime files (`package.json`, `server.js`, `public/`), run as the non-root `node` user, set `HOST=0.0.0.0` and `PORT=5173`, expose port 5173 and define a HEALTHCHECK that requests `/` and fails on a non-2xx response. `compose.yaml` SHALL publish the port as `127.0.0.1:${PORT:-5173}:5173` and use `restart: unless-stopped`. The image SHALL NOT contain `response.txt`, `test/`, `openspec/`, `.env` files or any API key.

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
- **THEN** the app is reachable at `http://localhost:8080` and only from the local machine

### Requirement: Light and dark theme
The UI SHALL offer a light and a dark theme with identical layout, each meeting WCAG AA text contrast. With no stored choice the theme SHALL follow the operating system's `prefers-color-scheme` and update live when it changes. A header toggle button (accessible label "Chuyển sang giao diện sáng" / "Chuyển sang giao diện tối", `aria-pressed` true when dark) SHALL switch themes and persist the choice in localStorage; a stored choice overrides the OS setting. The theme SHALL be applied before first paint (no flash). Unavailable storage SHALL fall back to the OS setting without errors.

#### Scenario: Follow OS
- **WHEN** no choice is stored and the OS prefers light
- **THEN** the light theme is shown

#### Scenario: Persist choice
- **WHEN** the user switches to dark and reloads the page
- **THEN** the dark theme is shown regardless of the OS setting
