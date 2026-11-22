/**
 * Convert a WAV buffer to MP3 via host ffmpeg (operator machine has it).
 * Used for Kokoro recording downloads only - in-app playback stays WAV.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function wavBufferToMp3(wav: Buffer): Promise<Buffer> {
  const id = randomUUID();
  const inPath = join(tmpdir(), `tierwyn-tts-${id}.wav`);
  const outPath = join(tmpdir(), `tierwyn-tts-${id}.mp3`);
  writeFileSync(inPath, wav);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        'ffmpeg',
        [
          '-y',
          '-i', inPath,
          // VBR quality ~4 - speech-friendly size without pure-JS encoder dep
          '-codec:a', 'libmp3lame',
          '-q:a', '4',
          outPath,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let err = '';
      child.stderr?.on('data', (d: Buffer) => {
        err += d.toString();
      });
      child.on('error', (e) => reject(e));
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(err.slice(-400) || `ffmpeg exited ${code}`));
      });
    });
    return readFileSync(outPath);
  } finally {
    try { unlinkSync(inPath); } catch { /* ignore */ }
    try { unlinkSync(outPath); } catch { /* ignore */ }
  }
}
