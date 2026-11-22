"""Tierwyn Kokoro TTS sidecar; native (no Docker), OpenAI-compatible subset.

  POST /v1/audio/speech  {"input": str, "voice": "af_heart", "speed"?: float} → audio/wav
  GET  /v1/audio/voices  → {"voices": ["af_heart", ...]}
  GET  /health           → {"status": "healthy", "device": "cuda"}

Device comes from KOKORO_DEVICE (cpu | cuda; ROCm builds of PyTorch also report "cuda").
Installed + run by `tierwyn sidecars` (venv ~/kokoro-venv, unit tierwyn-kokoro.service).
"""
from __future__ import annotations

import argparse
import io
import json
import os
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import torch
from huggingface_hub import list_repo_files
from huggingface_hub.constants import HF_HUB_CACHE
from kokoro import KModel, KPipeline

REPO = "hexgrad/Kokoro-82M"
RATE = 24000
# Voice id prefix letter → KPipeline lang_code (ja/zh via misaki[ja,zh] + unidic-lite).
LANGS = set("abefhijpz")
try:  # Japanese is optional: pyopenjtalk needs a compiler to install (see `tierwyn sidecars`)
    import pyopenjtalk  # noqa: F401
except ImportError:
    LANGS.discard("j")


def _device() -> str:
    want = os.environ.get("KOKORO_DEVICE", "cpu")
    if want == "cuda" and not torch.cuda.is_available():
        print("[kokoro] KOKORO_DEVICE=cuda but no GPU visible to torch, using cpu", flush=True)
        return "cpu"
    return want


def _limit_gpu_memory() -> None:
    # Shared display iGPU (e.g. 780M): cap this process's VRAM share. 0/off disables.
    raw = os.environ.get("KOKORO_GPU_MEM_FRACTION", "").strip()
    try:
        frac = float(raw)
    except ValueError:
        return
    if 0 < frac <= 1:
        torch.cuda.set_per_process_memory_fraction(frac, 0)


def _voices() -> list[str]:
    try:
        files = list_repo_files(REPO)
    except Exception:  # offline: whatever voices are already cached
        snap = Path(HF_HUB_CACHE) / f"models--{REPO.replace('/', '--')}" / "snapshots"
        files = [f"voices/{p.name}" for p in snap.glob("*/voices/*.pt")]
    return sorted({f[7:-3] for f in files if f.startswith("voices/") and f.endswith(".pt") and f[7] in LANGS})


class Engine:
    def __init__(self) -> None:
        self.device = _device()
        if self.device == "cuda":
            _limit_gpu_memory()
        self.model = KModel(repo_id=REPO).to(self.device).eval()
        self.pipes: dict[str, KPipeline] = {}
        self.voices = _voices()
        # ponytail: one synthesis at a time: a single small GPU/CPU, no batching needed.
        self.lock = threading.Lock()
        self.wav("Ready.", "af_heart")  # warm-up: surfaces HIP/CUDA failures at start, not on first request

    def wav(self, text: str, voice: str, speed: float = 1.0) -> bytes:
        lang = voice[:1]
        if lang not in LANGS:
            raise ValueError(f"unsupported voice {voice!r}")
        with self.lock:
            pipe = self.pipes.get(lang)
            if pipe is None:
                pipe = self.pipes[lang] = KPipeline(lang_code=lang, repo_id=REPO, model=self.model)
            chunks = [r.audio.cpu().numpy() for r in pipe(text, voice=voice, speed=speed) if r.audio is not None]
        audio = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
        return buf.getvalue()


ENGINE: Engine


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: bytes, ctype: str = "application/json") -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj: object) -> None:
        self._send(code, json.dumps(obj).encode())

    def do_GET(self) -> None:
        if self.path == "/health":
            self._json(200, {"status": "healthy", "device": ENGINE.device})
        elif self.path == "/v1/audio/voices":
            self._json(200, {"voices": ENGINE.voices})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/v1/audio/speech":
            return self._json(404, {"error": "not found"})
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            text = str(req.get("input") or "").strip()
            voice = str(req.get("voice") or "af_heart")
            speed = float(req.get("speed") or 1.0)
            if not text:
                return self._json(400, {"error": "input is required"})
            # ponytail: WAV only: the one format Tierwyn requests.
            self._send(200, ENGINE.wav(text, voice, speed), "audio/wav")
        except ValueError as e:
            self._json(400, {"error": str(e)})
        except Exception as e:  # keep serving after a bad request / transient GPU error
            self._json(500, {"error": f"{type(e).__name__}: {e}"})

    def log_message(self, fmt: str, *args: object) -> None:
        pass


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8880)
    args = ap.parse_args()
    global ENGINE
    ENGINE = Engine()  # load before listening: an open port means ready
    print(f"[kokoro] ready on {args.host}:{args.port} · device={ENGINE.device} · {len(ENGINE.voices)} voices", flush=True)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
