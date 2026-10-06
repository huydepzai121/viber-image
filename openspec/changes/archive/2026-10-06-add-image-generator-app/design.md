## Context

Empty project (only `response.txt`, a real sample response). Node.js 24 is installed. Visual design: dark theme, Manrope + JetBrains Mono, three numbered cards. Requirements: `specs/image-generation/spec.md`.

## Goals / Non-Goals

**Goals:** run with `npm start`, no install step, no build step; pure logic unit-testable in Node.

**Non-Goals:** image history/gallery, editing/variations endpoints, multi-user hosting, authentication of the local server, bundling/minification.

## Decisions

- **Local proxy server instead of direct browser fetch.** Upstream CORS policy is unknown and URL images may not allow cross-origin reads (needed to download with a chosen filename). A `node:http` server in `server.js` serves `public/` and proxies. Alternative (pure static page) rejected: fails whenever upstream lacks CORS headers.
- **Zero dependencies.** `node:http`, global `fetch`, `node:test`. Alternative (Express/Vite) adds install steps for no benefit at this size.
- **Shared pure module `public/lib.js`** (ES module, no DOM): `normalizeBaseUrl`, `buildEndpoint`, `extractImages`, `makeFilename`, `formatErrorBody`. Imported by `public/app.js` and by `server.js`/tests via `import`. Keeping it under `public/` makes it servable without duplication.
- **b64 rendering via Blob URLs** (`atob` → `Uint8Array` → `Blob` → `URL.createObjectURL`), revoked when results are replaced. Avoids huge data-URI strings in the DOM (sample is ~2.9 MB).
- **Downloads** via an `<a download>` on a Blob URL; URL images are fetched from `/api/fetch-image` into a Blob first. "Tải tất cả" triggers downloads sequentially with a short delay.
- **Filename timestamp** captured once when the response arrives (local time), shared by all images of that response.
- **State**: a single plain object + `render()` function in `app.js`; DOM is static HTML in `index.html`, toggled with `hidden`. No framework.
- **Server safety**: static files resolved with `path.resolve` and checked to stay inside `public/`; 1 MB body cap; bind `127.0.0.1`; key never logged; upstream timeout 180 s via `AbortSignal.timeout`.
- **Testability**: `server.js` exports `createServer({ fetchImpl })`; it only listens when run directly. Tests start it on port 0 against a mock upstream `http` server.
- **n > 1 is fanned out server-side.** The upstream (`bedrock.viber.vn`) answers 400 `BAD_REQUEST` to any request with `n` > 1 (verified by direct curl; `n=1` works for all sizes). `/api/generate` therefore issues n concurrent upstream requests with `n:1`, merges their `data` arrays in order and returns `{created, data}`. If any request fails, the first failing response (in request order) is passed through verbatim; a network failure is 502. `n=1` is a plain passthrough. Alternative (n sequential/parallel calls from the browser) rejected: keeps the UI to a single request and error path.

## Risks / Trade-offs

- [API key in localStorage is readable by any script on the origin] → origin is local-only and serves no third-party scripts except Google Fonts CSS; documented in README.
- [Large responses (n=4 at high res, tens of MB)] → proxy streams/buffers once; no size cap on responses.
- [`/api/fetch-image` is an open fetcher] → bound to 127.0.0.1 and limited to http/https.
- [Browsers may block multiple automatic downloads] → sequential with delay; per-image buttons remain.

## Migration Plan

New app; no migration. Rollback = delete the files.

## Docker

- **Bind address via `HOST`.** Local runs keep `127.0.0.1` (the proxy is an open fetcher); the container sets `HOST=0.0.0.0` because Docker port publishing needs it, and `compose.yaml` re-restricts exposure by publishing on `127.0.0.1` only. Alternative (always `0.0.0.0`) rejected: exposes the proxy on the LAN for `npm start` users.
- **Single-stage `node:22-alpine`, no `npm install`.** Zero dependencies, so no build stage is needed. `COPY` only runtime files; `.dockerignore` excludes everything else (`response.txt` is ~3 MB and test-only).
- **HEALTHCHECK** uses `node -e "fetch('http://127.0.0.1:5173/')…"` since Alpine has no curl by default.
- **No secrets in image or compose.** API key is entered in the UI and lives in the browser's localStorage only.
