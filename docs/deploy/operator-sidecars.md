# Operator-managed sidecars (systemd glue)

Tierwyn **does not start or supervise** TTS/STT helper processes. The app only
**proxies** to URLs from Settings (or discovers local binaries for whisper).
Anything that must survive reboot is an **operator-managed** user systemd unit
outside the Node process.

This is intentional: sidecars stay loopback-only, restart independently of the
API, and never ship Python/model weights inside the monorepo runtime.

| Component | Tierwyn role | Operator role |
|---|---|---|
| `tierwyn-prod` / `tierwyn-prod-web` | Core app | User units in `docs/deploy/systemd/` |
| Piper TTS wrapper | `POST /tts/synthesize` → `piperUrl` (default `http://127.0.0.1:5000`); voice list/download under `~/piper-voices` | Install wrapper + venv + **enable `tierwyn-piper.service`** |
| Kokoro TTS (optional) | `POST /tts/synthesize` → `kokoroUrl` (default `http://127.0.0.1:8880`); `GET /tts/config` → `kokoroUp` | `tierwyn sidecars` → Kokoro (native venv) + **enable `tierwyn-kokoro.service`** |
| whisper-cli (STT) | Spawns binary on demand; models under `~/.local/share/mewisper/` | Install binary + models; see `.env.example` `WHISPER_*` |
| Grok Bot desktop | Lifecycle supervisor starts the app on demand/keep-running when configured (`apps/server/src/adapters/grok-bot/supervisor.ts`); otherwise attach to external instance (`TIERWYN_GROKBOT_CDP_PORT`, default 9333). | Install the `.deb`, enable `tierwyn-grokbot.service` (or start the app with `--remote-debugging-port=9333`) |

**Retention rule:** if a process is required for a Settings provider to work,
it must have a **versioned unit template** under `docs/deploy/systemd/` and
install steps in this file (or CLAUDE.md). Do not leave setup only in private
or unversioned notes.

---

## User systemd prerequisites (all units)

```bash
# Units must keep running after logout / before login:
loginctl enable-linger "$USER"
# Confirm:
loginctl show-user "$USER" -p Linger   # Linger=yes
```

Install a unit from the repo templates:

```bash
mkdir -p ~/.config/systemd/user
cp docs/deploy/systemd/tierwyn-*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now tierwyn-prod.service tierwyn-prod-web.service
# optional TTS:
systemctl --user enable --now tierwyn-piper.service
systemctl --user enable --now tierwyn-kokoro.service   # after tierwyn sidecars built ~/kokoro-venv
```

Ops:

```bash
# App deploy restart (build all workspaces + restart API + web)
npm run deploy:prod:full

systemctl --user status tierwyn-prod tierwyn-prod-web tierwyn-piper tierwyn-kokoro --no-pager
journalctl --user -u tierwyn-piper -f
journalctl --user -u tierwyn-kokoro -f
```

---

## Piper multi-voice TTS

### Glue model

```
Browser play button
  → speak.ts (provider=piper)
  → POST /tts/synthesize  (Tierwyn API, cookie auth)
  → POST http://127.0.0.1:5000/  { text, voice }  (Flask wrapper)
  → WAV bytes → HTMLAudioElement

Tierwyn never spawns the wrapper. If port 5000 is down:
  GET /tts/config → piperUp:false
  speak falls back to browser speechSynthesis
```

Settings (prod DB `voice.tts`): `enabled`, `provider: "piper"`,
`piperUrl: "http://127.0.0.1:5000"`, `piperVoice: "<stem>"`.

### Paths (operator-owned, not in git working tree)

| Path | Purpose |
|---|---|
| `~/tierwyn-piper/server.py` | Live Flask wrapper (install from `docs/deploy/piper/server.py`) |
| `~/piper-venv/` | Python venv: `piper-tts` + `flask` |
| `~/piper-voices/*.onnx` (+ sibling `.onnx.json`) | Voice models; UI downloader writes here |
| `~/.config/systemd/user/tierwyn-piper.service` | Autostart on `127.0.0.1:5000` |

**Versioned copies in repo:**

| Repo path | Purpose |
|---|---|
| `docs/deploy/piper/server.py` | Wrapper source of truth |
| `docs/deploy/systemd/tierwyn-piper.service` | Unit template |

### First-time install

```bash
# 0. Free port 5000 if a legacy one-voice server is still up
pkill -f 'piper.http_server' || true
ss -tlnp | grep 5000 || echo 'port free'

# 1. Venv
python3 -m venv ~/piper-venv
~/piper-venv/bin/pip install --upgrade pip piper-tts flask

# 2. Wrapper
mkdir -p ~/tierwyn-piper
cp /path/to/Tierwyn/docs/deploy/piper/server.py ~/tierwyn-piper/server.py

# 3. At least one voice (or use Settings → Voice → Download more voices… after unit is up)
mkdir -p ~/piper-voices
# Optional manual seed: HF paths match apps/server/src/piper-voices.json
# e.g. en_US-lessac-medium.onnx + .onnx.json under rhasspy/piper-voices
# Voice models are not shipped with Tierwyn; each HF voice carries its own licence
# (often CC0/CC-BY: check before commercial use).

# 4. Systemd user unit
mkdir -p ~/.config/systemd/user
cp /path/to/Tierwyn/docs/deploy/systemd/tierwyn-piper.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now tierwyn-piper.service
```

### Verify

```bash
systemctl --user is-active tierwyn-piper.service    # active
systemctl --user is-enabled tierwyn-piper.service   # enabled
ss -tlnp | grep 5000                               # 127.0.0.1:5000
curl -s http://127.0.0.1:5000/voices               # JSON array of stems
curl -s -X POST http://127.0.0.1:5000/ \
  -H 'Content-Type: application/json' \
  -d '{"text":"hello","voice":"en_US-lessac-medium"}' \
  -o /tmp/piper-test.wav -w '%{http_code}\n'
file /tmp/piper-test.wav                           # WAVE audio
```

In the UI: Settings → Voice → provider **Piper** → pick voice → play a message.
No Tierwyn restart needed when the sidecar comes up.

### Failure modes (seen in production)

| Symptom | Cause | Fix |
|---|---|---|
| UI on Piper but browser-sounding voice / silent fallback | Unit never installed or not running | `systemctl --user enable --now tierwyn-piper` |
| `piperUp: false` on `GET /tts/config` | Nothing on `piperUrl` | Check unit + `ss -tlnp \| grep 5000` |
| Voices installed, synth 404 | `piperVoice` stem not in `~/piper-voices` | Download in UI or fix Settings voice |
| Wrapper dies after reboot | Unit not enabled / no linger | `enable` + `loginctl enable-linger $USER` |
| Port busy | Leftover `python -m piper.http_server` | `pkill -f piper.http_server` |

Tierwyn prod **does not** `Wants=` or `Requires=` the piper unit (soft coupling).
Start piper separately so a broken TTS install cannot block the API.

### Updating the wrapper

```bash
cp docs/deploy/piper/server.py ~/tierwyn-piper/server.py
systemctl --user restart tierwyn-piper.service
```

---

## Kokoro TTS (native sidecar)

Kokoro runs natively; no Docker. A Python 3.12 venv holds the [`kokoro`](https://pypi.org/project/kokoro/)
package (Kokoro-82M, Apache-2.0) and a PyTorch build matched to the hardware; a small stdlib HTTP wrapper
(`docs/deploy/kokoro/server.py`) serves the OpenAI-compatible subset Tierwyn calls. **Tierwyn does not start it.**

**Install with `tierwyn sidecars` → Kokoro.** It detects the hardware, recommends a device, and lets you pick:

| Device | PyTorch build | Detected as ready when |
|---|---|---|
| `cpu` | `whl/cpu` (~0.2 GB) | always; about 5× real-time on a Ryzen 7940HS |
| `cuda` (NVIDIA) | `whl/cu130` or `whl/cu126`, from the driver's max CUDA version | `nvidia-smi` works and reports CUDA ≥ 12.6 |
| `rocm` (AMD) | `whl/rocm7.1` | x86_64, `/dev/kfd` + `/dev/dri/renderD*` accessible, KFD reports a gfx target |

A GPU that fails warm-up offers a fall back to CPU (a GPU PyTorch build runs fine on CPU).
`TIERWYN_KOKORO_PROFILE=cpu|cuda|rocm` skips the question; `TIERWYN_HSA_OVERRIDE` overrides the ROCm gfx version.

### Glue model

```
Tierwyn API  ──HTTP──▶  127.0.0.1:8880  (tierwyn-kokoro.service → ~/kokoro-venv/bin/python server.py)
  POST /v1/audio/speech {input, voice, speed?} → audio/wav (24 kHz mono)
  GET  /v1/audio/voices → {voices: [...]}   GET /health → {status, device}
```

The port only opens after the model has loaded and synthesised a warm-up sentence, so an open port means ready.
Voices are the `hexgrad/Kokoro-82M` voice files for American/British English, Spanish, French, Hindi, Italian
and Portuguese (`a b e f h i p` prefixes). Japanese and Chinese voices need extra G2P packages and are not listed.

### Paths

| Path | Purpose |
|---|---|
| `docs/deploy/kokoro/server.py` | **Versioned** wrapper source |
| `docs/deploy/systemd/tierwyn-kokoro.service` | **Versioned** unit template |
| `~/tierwyn-kokoro/server.py` | Live wrapper |
| `~/kokoro-venv/` | uv venv (Python 3.12, kokoro needs < 3.13); `.tierwyn-torch` records the PyTorch build |
| `~/.config/tierwyn/kokoro.env` | `KOKORO_DEVICE` + ROCm tuning; edit and restart to switch device |
| `~/.cache/huggingface/` | Model weights (~330 MB) and voices, downloaded on first start |

### Switch device

Re-run `tierwyn sidecars` and pick another device (it swaps the PyTorch build when needed). To drop a GPU
install back to CPU without reinstalling, set `KOKORO_DEVICE=cpu` in `~/.config/tierwyn/kokoro.env` and
`tierwyn restart kokoro`.

### Verify

```bash
curl -s http://127.0.0.1:8880/health          # {"status": "healthy", "device": "cpu"}
curl -s -X POST http://127.0.0.1:8880/v1/audio/speech \
  -H 'Content-Type: application/json' -d '{"input":"hello","voice":"af_heart"}' -o /tmp/k.wav
file /tmp/k.wav                                 # RIFF … WAVE audio, 24000 Hz
```

### Failure modes

| Symptom | Fix |
|---|---|
| `uv pip install kokoro` tries to build `tokenizers==0.10.3` | resolver backtracked to an old `transformers`; the installer pins `transformers>=4.45` |
| ROCm warm-up fails / hangs | wrong `HSA_OVERRIDE_GFX_VERSION` (gfx1103 needs `11.0.0`, not `11.0.3`); or choose CPU |
| `device: cpu` while `KOKORO_DEVICE=cuda` | torch sees no GPU (driver, `/dev/kfd` permissions, render/video groups); logged at start |
| Port 8880 busy, unit inactive | an old Docker Kokoro container; `tierwyn sidecars` stops and removes it on upgrade |

### Upgrading from the Docker sidecar

`tierwyn sidecars` detects the old Compose-based unit, stops it and removes the `kokoro` container. The image is
left in place: `docker image rm ghcr.io/remsky/kokoro-fastapi-{cpu,gpu,rocm}` and `rm -r ~/.config/kokoro` reclaim it.

## Grok Bot desktop (CDP attach)

The `grok-bot` adapter attaches over loopback Chrome DevTools Protocol
(`TIERWYN_GROKBOT_CDP_PORT`, default `9333`). A lifecycle supervisor
(`apps/server/src/adapters/grok-bot/supervisor.ts`) can start the desktop app
when Grok Bot is enabled and auto-start policy allows it (`keep-running` /
on-demand / manual). Set `TIERWYN_GROKBOT_AUTOSTART=0` to kill launching
(including the Settings Start / Retry button). If the port is down and the
supervisor is not launching, picking **Grok Bot · Default** yields a clean
error event; it still never launches the app from the adapter itself.

### Glue model

```
Tierwyn grok-bot adapter
  → GET http://127.0.0.1:9333/json/list  (page target only, not webview)
  → CDP Runtime.evaluate / Input.* on the renderer
```

### Install / enable

```bash
# App already installed at /opt/Grok Bot/grok-bot (official .deb).
# Persist the CDP flag across updates:
mkdir -p ~/.config/grok-bot
echo '--remote-debugging-port=9333' >> ~/.config/grok-bot/electron-flags.conf

cp docs/deploy/systemd/tierwyn-grokbot.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now tierwyn-grokbot.service
curl -s http://127.0.0.1:9333/json/version   # expect Browser: GrokBot/…
```

If the unit cannot see your display, start the app yourself from the desktop:

```bash
DISPLAY=:0 '/opt/Grok Bot/grok-bot' --remote-debugging-port=9333 &
```

Sign in once in the GUI (Cursor/xAI account). The adapter never types into auth forms.

Post-update selector smoke (not CI): `node scripts/grokbot-smoke.mjs`

---

## Related

- Agent-facing summary: [CLAUDE.md](../../CLAUDE.md) § Production deployment / Piper / Kokoro
- TLS / reverse proxy: [deployment.md](./deployment.md)
- Unit templates: [systemd/](./systemd/)
- Whisper path/env: [../../.env.example](../../.env.example)

