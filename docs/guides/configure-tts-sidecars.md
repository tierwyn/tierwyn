# Configure Piper and Kokoro TTS Sidecars

This guide explains how to configure and run local Text-to-Speech (TTS) sidecar services for speech synthesis in Tierwyn.

---

## 1. Understand Sidecar Architecture

Tierwyn does not spawn or manage TTS processes directly. Speech synthesis sidecars run as standalone processes or Docker containers supervised by systemd user units:

| Service | Provider Key | Default Endpoint | Default Voice | Runtime Type |
|---|---|---|---|---|
| **Piper TTS** | `piper` | `http://127.0.0.1:5000` | `en_US-lessac-medium` | Python Flask service |
| **Kokoro TTS** | `kokoro` | `http://127.0.0.1:8880` | `af_heart` | Native venv (CPU / CUDA / ROCm) |

---

## 2. Set Up Piper TTS Sidecar

1. Create a dedicated directory and copy the Piper Flask wrapper:
   ```bash
   mkdir -p ~/tierwyn-piper
   cp docs/deploy/piper/server.py ~/tierwyn-piper/
   ```
2. Install dependencies and download ONNX voice models to `~/tierwyn-piper/voices/`.
3. Install and start the systemd user unit:
   ```bash
   cp docs/deploy/systemd/tierwyn-piper.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now tierwyn-piper.service
   ```

---

## 3. Set Up Kokoro TTS Sidecar

Kokoro runs natively in a Python venv. `tierwyn sidecars` detects your hardware, lets you choose CPU or GPU (NVIDIA CUDA / AMD ROCm), and installs the unit. Model weights and voices download on first start. To repeat or switch the device, run it again:

1. Install, or switch CPU/GPU:
   ```bash
   tierwyn sidecars   # → Kokoro
   ```
2. Verify that Kokoro is listening on port 8880:
   ```bash
   curl http://127.0.0.1:8880/v1/audio/speech -X POST -H "Content-Type: application/json" -d '{"input":"test","voice":"af_heart"}' --output /dev/null -s -w "%{http_code}\n"
   ```

---

## 4. Verify Sidecar Status

Check the status of both TTS systemd units:

```bash
systemctl --user status tierwyn-piper.service tierwyn-kokoro.service
```
