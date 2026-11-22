# Kokoro TTS: native sidecar

`server.py` is a small stdlib HTTP wrapper around the [`kokoro`](https://pypi.org/project/kokoro/)
package, serving a subset of the OpenAI-compatible API on **`http://127.0.0.1:8880`**. No Docker.
Any app that speaks this subset can use it. For example, a client sends `voice` + `input`
and gets WAV back, and its extra `lang_code` field is ignored because the language comes from the
voice prefix.

| Endpoint | |
|---|---|
| `POST /v1/audio/speech` | `{"input", "voice": "af_heart", "speed"?}` → `audio/wav` (24 kHz, 16-bit mono) |
| `GET /v1/audio/voices` | `{"voices": [...]}`: en-US/GB, es, fr, hi, it, pt-BR, zh (+ ja when a compiler was available) |
| `GET /health` | `{"status": "healthy", "device": "cpu"}`. The port opens only after warm-up. |

## Install

Run `tierwyn sidecars` → Kokoro. It detects the GPU but lets you pick **CPU**, **NVIDIA (CUDA)** or
**AMD (ROCm)**. To skip the prompt, set `TIERWYN_KOKORO_PROFILE=cpu|cuda|rocm`. It then:

1. Creates `~/kokoro-venv`, a Python 3.12 venv built with uv because kokoro needs Python < 3.13. The venv gets the
   matching PyTorch build (`cpu`, `cu130`/`cu126`, or `rocm7.1`) plus `kokoro` and `misaki[zh]`. Japanese (`misaki[ja]` +
   `unidic-lite`) needs cmake + g++ for `pyopenjtalk`; without them it is skipped with a hint.
2. Copies `server.py` to `~/tierwyn-kokoro/` and installs `docs/deploy/systemd/tierwyn-kokoro.service`.
3. Writes `~/.config/tierwyn/kokoro.env` with `KOKORO_DEVICE` set, plus the ROCm tuning variables
   when you choose ROCm.

The model weights (~330 MB) and the voices download from Hugging Face on first start, into
`~/.cache/huggingface`.

**Switch device:** run `tierwyn sidecars` again and pick another device. This reinstalls PyTorch
when its build index changes.

## Check

```bash
curl -s http://127.0.0.1:8880/health
curl -s -X POST http://127.0.0.1:8880/v1/audio/speech -H 'Content-Type: application/json' \
  -d '{"input":"hello","voice":"af_heart"}' -o /tmp/k.wav && file /tmp/k.wav
journalctl --user -u tierwyn-kokoro -f
```

On CPU, expect roughly 5× real-time on a modern x86 core. Full operator notes:
[operator sidecars](../operator-sidecars.md).
