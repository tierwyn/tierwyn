import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { wavBufferToMp3 } from './wavToMp3.js';

function makeTinyWav(): Buffer {
  const path = join(tmpdir(), `tierwyn-test-src-${randomUUID()}.wav`);
  // 0.2s silence - needs a real RIFF WAV for ffmpeg to accept.
  const r = spawnSync(
    'ffmpeg',
    ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '0.2', path],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) {
    throw new Error(`fixture ffmpeg failed: ${r.stderr?.slice(-200)}`);
  }
  try {
    return readFileSync(path);
  } finally {
    try { unlinkSync(path); } catch { /* ignore */ }
  }
}

describe('wavBufferToMp3', () => {
  it('converts a small WAV to an MP3 buffer with ID3/MPEG frame header', async () => {
    const wav = makeTinyWav();
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    const mp3 = await wavBufferToMp3(wav);
    expect(mp3.length).toBeGreaterThan(100);
    // ID3 tag or frame sync (0xFFEx)
    const hasId3 = mp3[0] === 0x49 && mp3[1] === 0x44 && mp3[2] === 0x33;
    const hasSync = mp3[0] === 0xff && (mp3[1]! & 0xe0) === 0xe0;
    expect(hasId3 || hasSync).toBe(true);
  });
});
