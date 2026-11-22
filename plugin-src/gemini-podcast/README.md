# gemini-podcast

Agent-callable Gemini podcast writer + TTS. Agents call
`POST /agent/plugins/gemini-podcast/capabilities/podcast.script.generate` or
`…/podcast.audio.generate` and receive a script object or an absolute path
to a written WAV or MP3. They never see the API key, and audio bytes are
never returned over the wire — only the file path.

## Setup

1. Get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
2. Settings → Plugins → Gemini Podcast → set `GEMINI_API_KEY` (stored in the
   encrypted vault). Env fallback: `GEMINI_API_KEY=` in `.env` /
   `/etc/tierwyn/prod.env` (captured at boot and scrubbed from agent children).
   Same key name as `gemini-audiobook` / `gemini-image`; the vault is
   per-plugin, so set it here even if those already have a row. Env fallback
   is shared.
3. For MP3: `ffmpeg` with `libmp3lame` on the server PATH (this host:
   `/usr/bin/ffmpeg`). WAV works without it. MP3 requests fail with
   `bad_input` if ffmpeg is missing — they do not crash. A false ffmpeg
   probe is cached for the process lifetime; install ffmpeg then restart.
4. Import `plugin-archives/gemini-podcast.tar.gz` (Settings → Plugins), or
   live-dev:

```bash
mkdir -p plugins/gemini-podcast
cp plugin-src/gemini-podcast/{index.js,audio.js,gemini.js,script.js,package.json,HELP.md,README.md} plugins/gemini-podcast/
cp plugin-src/gemini-podcast/plugin.json.example plugins/gemini-podcast/plugin.json
```

Restart the API after install or upgrade. **Sibling modules (`audio.js`,
`gemini.js`, `script.js`) are cached; only `index.js` is cache-busted on
re-import.** Upgrades of this plugin need a server restart. Do not restart
`tierwyn-prod.service` from inside a live conversation — that kills the turn.

Grant the plugin on the conversation's capability profile, otherwise calls
return 403 `not_in_profile`.

## Manifest

- Capabilities:
  - `podcast.script.generate` (6 req/min, `timeoutMs` 300000)
  - `podcast.audio.generate` (2 req/min, `timeoutMs` 300000)
- Credential: `GEMINI_API_KEY` (required)
- Egress: `https://generativelanguage.googleapis.com` only
- Handlers stop at 280 s so the caller sees plugin `timeout`, not a host
  504. Audio may issue up to 48 Gemini TTS requests at concurrency 4.
  The host global outbound cap is 60/min, shared with every plugin.

Capability names use dots only (`podcast.script.generate`). Plugin
capability names cannot contain underscores.

## Agent usage

Agent-facing docs: `HELP.md`, served at `GET /agent/plugins/gemini-podcast/help`.

## Models

Text:

| key | fetch timeout | pick when |
| --- | --- | --- |
| `gemini-3.8-flash` (**default**) | 120 s | Cheap drafting / translation |
| `gemini-3.5-flash-lite` | 120 s | Fastest |
| `gemini-3.1-pro-preview` | 240 s | Stronger rewrite |
| `gemini-2.5-flash` | 120 s | Older flash |
| `gemini-2.5-pro` | 240 s | Older pro |

TTS:

| key | fetch timeout | pick when |
| --- | --- | --- |
| `gemini-3.8-flash-tts` (**default**) | 90 s | Flagship speech / dialogue |
| `gemini-3.8-flash-lite-tts` | 90 s | Fast, cheap |
| `gemini-2.5-pro-preview-tts` | 90 s | Older preview TTS |
| `gemini-2.5-flash-preview-tts` | 90 s | Older preview TTS |

30 prebuilt voices (Zephyr … Sulafat). Default speaker voices in order:
Zephyr, Puck, Kore, Charon, Aoede, Fenrir, Leda, Orus, Sulafat, Iapetus.

## Multi-speaker request shape

Phase 0 could not be run from an agent child (the key is scrubbed). v1 ships
the Podcast Studio app's field-tested shape: per-part `speech_metadata` **and**
`speechMetadata` with aliases `Speaker1` / `Speaker2`, plus
`speechConfig.multiSpeakerVoiceConfig.speakerVoiceConfigs`. The documented
single-text-part shape was not used.

## Artifacts

`<dirname(TIERWYN_DB)>/artifacts/<conversationId>/` (operator calls write to
`artifacts/operator/`). Prod: `./data/artifacts/`. No automatic cleanup —
delete by hand. 24 kHz mono 16-bit WAV is ~2.9 MB/min; prefer MP3 for long
shows.

## MP3

Built in-memory as 16-bit mono WAV, then piped to:

```
ffmpeg -hide_banner -loglevel error -f wav -i pipe:0 -codec:a libmp3lame -q:a 4 -f mp3 pipe:1
```

No temp files, no vendored encoder. MIT-licensed. Timeout 30 s.

## Errors

`bad_input` 400 · `credential_missing` 503 · `upstream_error` 502 (Gemini
non-OK, safety block, text-only reply, no Speaker lines) · `timeout` 504 ·
`rate_limited` 429. Timeout and HTTP errors name the model, never the key.

## Capability profiles

Optional: Settings → Capability Profiles → grant `gemini-podcast`. Assign
with `PATCH /conversations/:id { capabilityProfile }`. Out-of-profile calls
get 403 `not_in_profile`.
