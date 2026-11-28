# gemini-video

Agent-callable video generation and conversational editing with Google Gemini Omni
(`gemini-omni-1.2-flash`) through the Gemini Interactions API
(`POST /v1beta/interactions`). Agents call
`POST /agent/plugins/gemini-video/capabilities/video.generate` with a text prompt
(and optional keyframe images or `previousInteractionId`) and receive an absolute path
to a written MP4 with native audio. They never see the API key, and video bytes are
never returned over the wire.

## Setup

1. Uses the same Google AI Studio key as Gemini Image / Music / Podcast / Audiobook.
   Gemini Omni video generation has **no free tier**: the key's project must have
   billing enabled.
2. Import `plugin-archives/gemini-video.tar.gz` in Settings → Plugins (rebuild with
   `npm run package:plugins`).
3. Settings → Plugins → Gemini Video → set `GEMINI_API_KEY` (vault entries are per
   plugin, so paste the same key here). Env fallback: `GEMINI_API_KEY=` in `.env` /
   `/etc/tierwyn/prod.env` is shared by every Gemini plugin.

## Manifest

- Capability: `video.generate` (`agentCallable: true`, 2 req/min per caller,
  `timeoutMs` 300000, the host maximum)
- Credential: `GEMINI_API_KEY` (required)
- Egress: `https://generativelanguage.googleapis.com` only

## Models

| key | output | fetch timeout | notes |
| --- | --- | --- | --- |
| `gemini-omni-1.2-flash` (**default**) | 3–15 s MP4 with native audio | 285 s | 360p / 720p / 1080p / 4K, `16:9` or `9:16`, image-to-video, first/last frame, multi-turn edits |
| `gemini-omni-1.2-flash-ext` | 3–15 s MP4 with native audio | 285 s | Fixed-rate extended billing channel |

## Artifacts

`<dirname(TIERWYN_DB)>/artifacts/<conversationId>/` (operator calls write to
`artifacts/operator/`). Prod: `./data/artifacts/`. No automatic cleanup.

## Errors

`bad_input` 400 · `credential_missing` 503 · `upstream_error` 502 (non-OK HTTP, safety
block, no video in the reply) · `timeout` 504 · `rate_limited` 429. Errors name the
model, never the key.

Agent-facing docs: `HELP.md`, served at `GET /agent/plugins/gemini-video/help`.
