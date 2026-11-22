# gemini-image

Agent-callable Gemini image generation and remix. Agents call
`POST /agent/plugins/gemini-image/capabilities/image.generate` with a text prompt
and receive an absolute path to a written PNG or JPEG. They never see the API
key, and image bytes are never returned over the wire — only the file path.

## Setup

1. Get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
2. Settings → Plugins → Gemini Image → set `GEMINI_API_KEY` (stored in the
   encrypted vault). Env fallback: `GEMINI_API_KEY=` in `.env` /
   `/etc/tierwyn/prod.env` (captured at boot and scrubbed from agent children).
3. `cp plugins/gemini-image/plugin.json.example plugins/gemini-image/plugin.json`
4. Restart the API (`systemctl --user restart tierwyn-prod.service` for prod) —
   plugins load at boot.

## Upgrade from v1

When `plugin.json` is absent, the loader falls back to the committed
`plugin.json.example`. Installs running off the example pick up v2
(`timeoutMs: 180000`) on the next restart with no manual step.

Only installs that created their own `plugin.json` must add
`"timeoutMs": 180000` by hand, then restart. Without that override the
host 15 s race can 504 a call while the paid Gemini request still
completes — the default model's fetch budget is now 90 s (v1 was 12 s).

`{prompt}` still returns `{path, mime, bytes}` with the same input keys;
the default model is now `gemini-3.1-flash-image`.

## Manifest

- Capability: `image.generate` (`agentCallable: true`, 4 req/min per caller,
  `timeoutMs` 180000)
- Credential: `GEMINI_API_KEY` (required)
- Egress: `https://generativelanguage.googleapis.com` only
- One shared rate limit of **4 requests/min** covers every model; per-model
  limits would need a host change (out of scope).

## Agent usage

Agent-facing docs: `HELP.md`, served at `GET /agent/plugins/gemini-image/help`.

## Models

| key | alias | fetch timeout | sizes | ratios | max inputs | thinking | search | shutdown announced |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `gemini-3.1-flash-image` (**default**) | `gemini-3.1-flash-image-preview` | 90 s | 512 1K 2K 4K | standard + `1:4 4:1 1:8 8:1` | 14 | yes | yes | no shutdown announced |
| `gemini-3.1-flash-lite-image` | — | 30 s | 1K | standard | 14 | yes | no | no shutdown announced |
| `gemini-3-pro-image` | `gemini-3-pro-image-preview` | 170 s | 1K 2K 4K | standard | 14 | no | yes | no shutdown announced |

Standard ratios: `1:1 2:3 3:2 3:4 4:3 4:5 5:4 9:16 16:9 21:9`.
`gemini-3.1-flash-lite-image` accepts only those 10 standard ratios as plugin
policy (the model card mentions 14; we expose 10 deliberately).

Remix: put the source image in your artifacts dir (the path from a previous
generate, or `cp` it in), then pass `inputImages`. Paths outside that shard
are rejected.

## Artifacts

`<dirname(TIERWYN_DB)>/artifacts/<conversationId>/` (operator calls write to
`artifacts/operator/`). Prod: `./data/artifacts/`. No automatic cleanup —
delete by hand.

## Errors

`bad_input` 400 · `credential_missing` 503 · `upstream_error` 502 (Gemini
non-OK, safety block, text-only reply) · `timeout` 504 · `rate_limited` 429.
Timeout and HTTP errors name the model, never the key.
