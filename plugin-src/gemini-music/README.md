# gemini-music

Agent-callable music generation with Google Lyria through the Gemini Interactions API
(`POST /v1beta/interactions`). Agents call
`POST /agent/plugins/gemini-music/capabilities/music.generate` with a text prompt and
receive an absolute path to a written MP3 or WAV. They never see the API key, and audio
bytes are never returned over the wire.

## Setup

1. Uses the same Google AI Studio key as Gemini Image / Podcast / Audiobook. Lyria has
   **no free tier**: the key's project must have billing on.
2. Settings → Plugins → Gemini Music → set `GEMINI_API_KEY` (vault entries are per
   plugin, so paste the same key again here). Env fallback: `GEMINI_API_KEY=` in `.env` /
   `/etc/tierwyn/prod.env` is shared by every Gemini plugin.
3. Import `plugin-archives/gemini-music.tar.gz` in Settings → Plugins (build it with
   `npm run package:plugins`).

## Manifest

- Capability: `music.generate` (`agentCallable: true`, 2 req/min per caller,
  `timeoutMs` 300000, the host maximum)
- Credential: `GEMINI_API_KEY` (required)
- Egress: `https://generativelanguage.googleapis.com` only

## Models

| key | output | fetch timeout | formats | price |
| --- | --- | --- | --- | --- |
| `lyria-3.5` (**default**) | full song, a couple of minutes (prompt controls length) | 290 s | mp3, wav | $0.08 / song |
| `lyria-3-clip-preview` | 30 s clip | 120 s | mp3 | $0.04 / clip |

Not exposed yet: image inputs (Lyria 3.5 accepts up to 10) and Lyria RealTime streaming.

## Artifacts

`<dirname(TIERWYN_DB)>/artifacts/<conversationId>/` (operator calls write to
`artifacts/operator/`). Prod: `./data/artifacts/`. No automatic cleanup.

## Errors

`bad_input` 400 · `credential_missing` 503 · `upstream_error` 502 (non-OK HTTP, safety
block, no audio in the reply) · `timeout` 504 · `rate_limited` 429. Errors name the
model, never the key.

Agent-facing docs: `HELP.md`, served at `GET /agent/plugins/gemini-music/help`.
