## 1. Setup

- [x] 1.1 Create `package.json` (`"type": "module"`, `engines.node >=20`, scripts `start: node server.js`, `test: node --test`), no dependencies
- [x] 1.2 Create `.gitignore` (node_modules, .env)

## 2. Pure logic (`public/lib.js`)

- [x] 2.1 `normalizeBaseUrl` / `buildEndpoint` per spec (trim, trailing slashes, case-insensitive suffix removal, empty → default)
- [x] 2.2 `extractImages(json)` → `[{kind:'b64'|'url', src}]`, strips `data:...,` prefix, skips unusable items, tolerates missing/non-array `data`
- [x] 2.3 `makeFilename(date, index, total)` and `formatErrorBody(text)` (pretty JSON or raw text)
- [x] 2.4 Unit tests `test/lib.test.js` covering every spec scenario plus `response.txt` fixture ← (verify: all edge cases of normalization, prefix stripping, filename padding/suffix)

## 3. Local server (`server.js`)

- [x] 3.1 Static file serving from `public/` with path-traversal guard and correct content types
- [x] 3.2 `POST /api/generate`: 1 MB cap (413), JSON validation (400), forward with Bearer header, passthrough status/content-type/body, network error → 502 JSON, 180 s timeout
- [x] 3.3 `GET /api/fetch-image`: http/https only (400), stream bytes, upstream error status passthrough
- [x] 3.4 Export `createServer`, listen on `127.0.0.1:${PORT||5173}` only when run directly; never log the key
- [x] 3.5 Integration tests `test/server.test.js` with a mock upstream ← (verify: body/headers forwarded exactly, 401/429/502/400/413 cases, fetch-image streaming)
- [x] 3.6 Work around upstream rejecting n>1: `/api/generate` fans out n requests with `n:1`, merges `data` in order, passes the first failure through verbatim; request preview notes × n; tests with mock upstream (n=3 → 3 calls merged, one failing → passthrough)

## 4. UI (`public/index.html`, `public/styles.css`, `public/app.js`)

- [x] 4.1 Markup and styles matching the approved dark design (header, Kết nối / Mô tả ảnh / Kết quả cards, size tiles with ratio icons, n segmented control, request preview `<details>`), responsive stacking below ~900px, labels and focus styles, AA contrast
- [x] 4.2 Settings: key show/hide toggle with aria-label switch, localStorage load/save with validation fallback
- [x] 4.3 Generate flow: validation messages + focus, loading state (disabled button, spinner, n placeholders), Ctrl/Cmd+Enter, elapsed time, aria-live announcements
- [x] 4.4 Results: Blob-URL rendering for b64, URL rendering, source badge, success banner, revoke old Blob URLs
- [x] 4.5 Errors: status line, pretty body, copy button with "Đã sao chép", no-images case
- [x] 4.6 Downloads: per-image and "Tải tất cả" with correct filenames, URL images via `/api/fetch-image`, inline error on failure ← (verify: end-to-end in browser against mock or real endpoint; filenames match spec)

## 5. Docs

- [x] 5.1 `README.md` (Vietnamese): requirements, `npm start`, `npm test`, PORT, how Base URL suffix works, localStorage note

## 6. Docker

- [x] 6.1 Make `server.js` read `HOST` (default `127.0.0.1`) alongside `PORT`; add a test that the default stays `127.0.0.1`
- [x] 6.2 Add `Dockerfile` (node:22-alpine, `WORKDIR /app`, copy `package.json server.js public/`, `ENV HOST=0.0.0.0 PORT=5173 NODE_ENV=production`, `USER node`, `EXPOSE 5173`, HEALTHCHECK, `CMD ["node","server.js"]`) and `.dockerignore`
- [x] 6.3 Add `compose.yaml` (build `.`, ports `127.0.0.1:${PORT:-5173}:5173`, `restart: unless-stopped`)
- [x] 6.4 Document Docker usage in `README.md` ← (verify: `docker compose up -d --build` → healthy, `/` and `/lib.js` return 200, image lacks response.txt/test/openspec, runs as `node`; tear down afterwards)
