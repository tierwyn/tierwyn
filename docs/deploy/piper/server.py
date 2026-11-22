#!/usr/bin/env python3
"""Tierwyn Piper wrapper; lazy multi-voice HTTP synth.
POST / {text, voice} -> audio/wav. Voices load on first use from ~/piper-voices.
ponytail: single-user localhost sidecar; no auth, no rate limit."""
import io, wave
from pathlib import Path
from flask import Flask, request, Response, jsonify
from piper import PiperVoice

VOICES_DIR = Path.home() / "piper-voices"
app = Flask(__name__)
_cache: dict[str, PiperVoice] = {}

def _load(voice: str) -> PiperVoice:
    v = _cache.get(voice)
    if v is None:
        onnx = VOICES_DIR / f"{voice}.onnx"
        if not onnx.exists():
            raise FileNotFoundError(voice)
        v = PiperVoice.load(str(onnx))       # reads sibling {voice}.onnx.json
        _cache[voice] = v
    return v

@app.post("/")
def synth():
    data = request.get_json(force=True, silent=True) or {}
    text = (data.get("text") or "").strip()
    voice = data.get("voice") or ""
    if not text:  return jsonify(error="text required"), 400
    if not voice: return jsonify(error="voice required"), 400
    try: v = _load(voice)
    except FileNotFoundError: return jsonify(error=f"voice '{voice}' not installed"), 404
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        v.synthesize_wav(text, wf)           # piper 1.4.x: synthesize_wav(text, Wave_write) writes a complete WAV
    return Response(buf.getvalue(), mimetype="audio/wav")

@app.get("/voices")
def voices():
    return jsonify(sorted(p.stem for p in VOICES_DIR.glob("*.onnx")))

if __name__ == "__main__":
    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    app.run(host="127.0.0.1", port=5000)     # ponytail: matches piperUrl default
