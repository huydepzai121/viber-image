## Why

Generating images today means hand-editing and running a curl command against an OpenAI-compatible `/v1/images/generations` endpoint, then decoding base64 or downloading a URL by script. A small local web app removes the hardcoded key/endpoint/model and lets the user generate, preview and save images from a browser.

## What Changes

- New local web app (dark UI per the approved design) with three cards: Connection, Prompt, Result.
- Connection settings: Base URL (default `https://bedrock.viber.vn`; the app appends `/v1/images/generations` automatically), API key (masked, show/hide), model (default `gpt-image-2-5`). Settings persist in the browser.
- Request settings: prompt (required), `size` (`1024x1024`, `1536x1024`, `1024x1536`, `auto`), `n` (1–4).
- Generation via a local zero-dependency Node server that proxies the request upstream (avoids browser CORS) and returns the upstream status and body unchanged.
- Result rendering for both `data[i].b64_json` (with or without a `data:...;base64,` prefix) and `data[i].url`.
- Download of each image (and all images) as `img_YYYYMMDD_HHMMSS.png`, with `_1`…`_n` suffixes when more than one image is returned; URL images are fetched through the local server.
- Success notice (count, elapsed time, source field) or error panel showing HTTP status and the raw response body.
- Automated tests (`node --test`) and a README.

## Capabilities

### New Capabilities
- `image-generation`: Configuring the endpoint, submitting a generation request, displaying results or errors, and downloading generated images.

### Modified Capabilities

## Impact

- New files in an empty project: `package.json`, `server.js`, `public/` (HTML, CSS, JS modules), `test/`, `README.md`.
- No third-party runtime dependencies; requires Node.js ≥ 20 (uses global `fetch` and `node:test`).
- The API key is sent from the browser to the local server and forwarded upstream only; it is stored in the browser's localStorage.
- `response.txt` (existing sample response) is used read-only as a test fixture.
