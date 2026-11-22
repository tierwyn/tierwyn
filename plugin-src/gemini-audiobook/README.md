# gemini-audiobook

Agent-callable Gemini text-to-speech. Agents call
`POST /agent/plugins/gemini-audiobook/capabilities/audio.generate` or
`…/audiobook.generate.chapter` and receive an absolute path to a written WAV
or MP3. They never see the API key, and audio bytes are never returned over
the wire — only the file path.

## Setup

1. Get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
2. Settings → Plugins → Gemini Audiobook → set `GEMINI_API_KEY` (stored in the
   encrypted vault). Env fallback: `GEMINI_API_KEY=` in `.env` /
   `/etc/tierwyn/prod.env` (captured at boot and scrubbed from agent children).
   Same key name as `gemini-image`; the vault is per-plugin, so set it here
   even if image already has a row. Env fallback is shared.
3. For MP3: `ffmpeg` with `libmp3lame` on the server PATH (this host:
   `/usr/bin/ffmpeg`). WAV works without it. MP3 requests fail with
   `bad_input` if ffmpeg is missing — they do not crash.
4. Import `plugin-archives/gemini-audiobook.tar.gz` (Settings → Plugins), or
   live-dev:

```bash
mkdir -p plugins/gemini-audiobook
cp plugin-src/gemini-audiobook/{index.js,audio.js,gemini.js,package.json,HELP.md,README.md} plugins/gemini-audiobook/
cp plugin-src/gemini-audiobook/plugin.json.example plugins/gemini-audiobook/plugin.json
```

Restart the API after install or upgrade. **Sibling modules (`audio.js`,
`gemini.js`) are cached; only `index.js` is cache-busted on re-import.**
Upgrades of this plugin need a server restart. Do not restart
`tierwyn-prod.service` from inside a live conversation — that kills the turn.

## Manifest

- Capabilities:
  - `audio.generate` (10 req/min, `timeoutMs` 120000)
  - `audiobook.generate.chapter` (2 req/min, `timeoutMs` 300000)
- Credential: `GEMINI_API_KEY` (required)
- Egress: `https://generativelanguage.googleapis.com` only
- Chapter handlers stop at 280 s so the caller sees plugin `timeout`, not a
  host 504. A chapter may issue up to 48 Gemini TTS requests at concurrency 4.
  The host global outbound cap is 60/min, shared with every plugin.

The capability is named `audiobook.generate.chapter` (dots only). Plugin
capability names cannot contain underscores.

## Agent usage

Agent-facing docs: `HELP.md`, served at `GET /agent/plugins/gemini-audiobook/help`.

## Models

| key | fetch timeout | pick when |
| --- | --- | --- |
| `gemini-3.8-flash-lite-tts` (**default**) | 90 s | Fast, cheap narration |
| `gemini-3.8-flash-tts` | 90 s | Flagship speech / dialogue |
| `gemini-2.5-flash-preview-tts` | 90 s | Older preview TTS |

IDs verified against the Gemini API model catalogue (Google AI for Developers).
30 prebuilt voices (Zephyr … Sulafat).

## Artifacts

`<dirname(TIERWYN_DB)>/artifacts/<conversationId>/` (operator calls write to
`artifacts/operator/`). Prod: `./data/artifacts/`. No automatic cleanup —
delete by hand. 24 kHz mono 16-bit WAV is ~2.9 MB/min; prefer MP3 for long
chapters.

## MP3

Built in-memory as 16-bit mono WAV, then piped to:

```
ffmpeg -hide_banner -loglevel error -f wav -i pipe:0 -codec:a libmp3lame -q:a 4 -f mp3 pipe:1
```

No temp files, no vendored encoder. MIT-licensed. Timeout 30 s.

## Errors

`bad_input` 400 · `credential_missing` 503 · `upstream_error` 502 (Gemini
non-OK, safety block, text-only reply) · `timeout` 504 · `rate_limited` 429.
Timeout and HTTP errors name the model, never the key.

## Capability profiles

Optional: Settings → Capability Profiles → grant `gemini-audiobook` (for
example a custom `audio` profile, or add it next to `gemini-image`). Assign
with `PATCH /conversations/:id { capabilityProfile }`. Out-of-profile calls
get 403 `not_in_profile`. Adding this plugin to the built-in `media` profile
is a core change — ask the operator first.
