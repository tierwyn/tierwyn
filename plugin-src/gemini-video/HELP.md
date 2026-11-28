# gemini-video

## What it does

Generates or edits videos with Google Gemini Omni (`gemini-omni-1.2-flash`) and writes
an MP4 with native synchronized audio into your artifacts shard, returning
`{ path, mime, bytes, model, interactionId? }`. It never returns video bytes and never
exposes `GEMINI_API_KEY`.

## Call

`POST /agent/plugins/gemini-video/capabilities/video.generate`

```bash
curl --max-time 310 -s -X POST "http://127.0.0.1:$TIERWYN_LISTEN_PORT/agent/plugins/gemini-video/capabilities/video.generate" \
  -H "Authorization: Bearer <your spawn token>" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Slow aerial glide over a misty pine valley at dawn, soft wind and birdsong","resolution":"720p","aspectRatio":"16:9","duration":5}'
```

Video rendering can take 30–180 s: set your Bash tool timeout to `320000`.

## Input

| Field | Required | Notes |
| --- | --- | --- |
| `prompt` | yes | Text, max 8000 chars. Describe subject, camera motion, lighting, and audio/dialogue |
| `model` | no | `gemini-omni-1.2-flash` (**default**) or `gemini-omni-1.2-flash-ext` |
| `resolution` | no | `360p` (fast/cheap draft), `720p` (default), `1080p` (upscaled), or `4K` (upscaled) |
| `aspectRatio` | no | `16:9` (landscape) or `9:16` (portrait) |
| `duration` | no | Integer `3`–`15` (or `"3s"`–`"15s"`). With 2 `inputImages`, max is `10` |
| `inputImages` | no | Array of 1–2 image paths (PNG/JPEG/WEBP, ≤7 MB each) inside your own artifacts shard. 1 image = first frame (image-to-video); 2 images = first & last frame interpolation |
| `previousInteractionId` | no | `interactionId` from an earlier call to conversationally edit or extend that clip |
| `filename` | no | Bare basename `[A-Za-z0-9._-]`; `.mp4` added automatically; must not already exist |

## Cost

Paid tier only (no free tier). Approximate per-second rates: `360p` ~$0.023/s, `720p` ~$0.070/s,
`1080p` ~$0.104/s, `4K` ~$0.209/s (audio included). Draft at `360p`/`720p` and short durations
before rendering a final `1080p`/`4K` clip.

## Response and next step

```json
{"ok":true,"data":{"path":"/…/artifacts/<conversationId>/<name>.mp4","mime":"video/mp4","bytes":4567890,"model":"gemini-omni-1.2-flash","interactionId":"v1_…"}}
```

Give the user the `path`. Save `interactionId` if you plan to edit or extend the clip in a follow-up call.

## Limits and errors

**2 requests/min**; capability timeout 300 s.

| Status | Meaning | Action |
| --- | --- | --- |
| 400 | `bad_input`: invalid arguments or path outside your artifacts shard | Fix the args |
| 429 | `rate_limited` | Wait `retryAfter` |
| 503 | `credential_missing` | Tell the operator to set `GEMINI_API_KEY` in Settings → Plugins; don't retry |
| 502 | `upstream_error` (Gemini failure, safety block, free-tier key) | Rephrase the prompt, or tell the operator the key needs the paid tier |
| 504 | `timeout` | Retry once, or use a lower resolution / shorter duration |

## Forbidden

- Don't ask for or echo `GEMINI_API_KEY`.
- Don't call `generativelanguage.googleapis.com` directly; use this capability.
