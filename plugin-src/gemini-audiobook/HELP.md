# gemini-audiobook

## What it does

Writes Gemini TTS audio into your artifacts shard and returns
`{ path, mime, bytes, durationSec, sampleRate, segments }`. It never returns
audio bytes and never exposes `GEMINI_API_KEY`. Output is `audio/wav` or
`audio/mpeg` (MP3 via host `ffmpeg` + `libmp3lame`).

## Call

`POST /agent/plugins/gemini-audiobook/capabilities/audio.generate`

```bash
curl --max-time 120 -s -X POST "http://127.0.0.1:$TIERWYN_LISTEN_PORT/agent/plugins/gemini-audiobook/capabilities/audio.generate" \
  -H "Authorization: Bearer <your spawn token>" \
  -H 'Content-Type: application/json' \
  -d '{"text":"Hello from Tierwyn.","voice":"Puck","filename":"hello"}'
```

`POST /agent/plugins/gemini-audiobook/capabilities/audiobook.generate.chapter`

```bash
curl --max-time 310 -s -X POST "http://127.0.0.1:$TIERWYN_LISTEN_PORT/agent/plugins/gemini-audiobook/capabilities/audiobook.generate.chapter" \
  -H "Authorization: Bearer <your spawn token>" \
  -H 'Content-Type: application/json' \
  -d '{"title":"The Fox","chapterTitle":"Chapter 1","text":"The wood was quiet.\nAlice: (whisper) Hello.\nBob: Hi.","voice":"Kore","characters":[{"name":"Alice","voice":"Puck"},{"name":"Bob","voice":"Fenrir"}],"filename":"ch1"}'
```

For chapters, set your Bash tool timeout to `310000` so the tool call outlives the 300 s capability timeout.

## Input — `audio.generate`

| Field | Required | Notes |
| --- | --- | --- |
| `text` | yes | Passage, max 5000 chars. Longer text → use `audiobook.generate.chapter` |
| `voice` | no | Prebuilt voice, case-insensitive; default `Kore` |
| `model` | no | TTS model key; default `gemini-3.8-flash-lite-tts` |
| `style` | no | Expression cue, max 100 chars, no newlines. Spoken as `Say <style>: <text>` |
| `format` | no | `wav` (default) or `mp3` |
| `filename` | no | Bare basename `[A-Za-z0-9._-]`; extension forced from `format`; must not already exist |

## Input — `audiobook.generate.chapter`

| Field | Required | Notes |
| --- | --- | --- |
| `text` | yes | Chapter body, max 30 000 chars. Dialogue: `Name: line`. Cues: `(whisper) …` |
| `title` | no | Book title, max 200 chars; spoken in the narrator voice, then a 1.5 s pause |
| `chapterTitle` | no | Chapter title, max 200 chars; same pause after |
| `voice` | no | Narrator voice; default `Kore` |
| `characters` | no | Up to 8 `{name, voice}` entries; names unique, max 40 chars |
| `model` | no | Same models as `audio.generate` |
| `format` | no | `wav` (default) or `mp3` |
| `filename` | no | Same rules as `audio.generate` |

Unknown `Foo:` lines are treated as narration. Consecutive cue-less narration with the same voice is merged up to 1800 characters per Gemini request. Dialogue and cued lines are never merged. A chapter may produce at most 48 speech requests; split longer books into chapters.

## Voices

`Zephyr` `Puck` `Charon` `Kore` `Fenrir` `Leda` `Orus` `Aoede` `Callirrhoe` `Autonoe` `Enceladus` `Iapetus` `Umbriel` `Algieba` `Despina` `Erinome` `Algenib` `Rasalgethi` `Laomedeia` `Achernar` `Alnilam` `Schedar` `Gacrux` `Pulcherrima` `Achird` `Zubenelgenubi` `Vindemiatrix` `Sadachbia` `Sadaltager` `Sulafat`

## Models

| key | pick when |
| --- | --- |
| `gemini-3.8-flash-lite-tts` (**default**) | Fast, cheap, everyday narration |
| `gemini-3.8-flash-tts` | Flagship speech, dialogue nuance |
| `gemini-2.5-flash-preview-tts` | Older preview TTS |

## Response and next step

```json
{"ok":true,"data":{"path":"/…/artifacts/<conversationId>/<name>.wav","mime":"audio/wav","bytes":123456,"durationSec":12.5,"sampleRate":24000,"segments":3}}
```

Read the returned `path` with your file tool. Do not echo the file bytes.

## Size

24 kHz mono 16-bit WAV is about 2.9 MB per minute. A 30 000-char chapter is roughly 30 min, about 90 MB of WAV. Prefer `format: "mp3"` for long chapters (needs host `ffmpeg` with `libmp3lame`). If ffmpeg is missing, `mp3` fails with `bad_input` and WAV remains available.

## Limits and errors

`audio.generate` is **10 requests/min**; `audiobook.generate.chapter` is **2 requests/min**. A chapter can issue up to 48 outbound Gemini calls. The host global outbound cap is **60/min**, shared with every plugin — one chapter can consume most of that window.

Capability timeouts: 120 s (audio) and 300 s (chapter). The chapter handler stops itself at 280 s and returns `timeout` rather than a host 504.

| Status | Meaning | Action |
| --- | --- | --- |
| 400 | `bad_input` — invalid arguments, existing filename, too many segments, or mp3 without ffmpeg | Fix the args or split the chapter; use `format: "wav"` if ffmpeg is missing |
| 429 | `rate_limited` | Wait `retryAfter` |
| 503 | `credential_missing` | Tell the operator to set `GEMINI_API_KEY` in Settings → Plugins; don't retry |
| 502 | `upstream_error` (Gemini failure or safety block) | Rephrase or retry |
| 504 | `timeout` | Split the chapter; retry audio once |

## Forbidden

- Don't ask for or echo `GEMINI_API_KEY`.
- Don't call `generativelanguage.googleapis.com` directly — use these capabilities.
- Don't write a second file with the same `filename` in the same shard.
