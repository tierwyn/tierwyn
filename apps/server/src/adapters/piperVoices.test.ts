import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  listInstalledVoices,
  catalogueVoices,
  downloadVoice,
} from './piperVoices.js';

describe('piperVoices', () => {
  let tempDir: string;
  const prevDir = process.env.PIPER_VOICES_DIR;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'piper-voices-test-'));
    process.env.PIPER_VOICES_DIR = tempDir;
  });

  afterEach(() => {
    if (prevDir === undefined) delete process.env.PIPER_VOICES_DIR;
    else process.env.PIPER_VOICES_DIR = prevDir;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('listInstalledVoices returns [] for an empty dir', () => {
    expect(listInstalledVoices()).toEqual([]);
  });

  it('listInstalledVoices returns id + parsed label from sidecar', () => {
    writeFileSync(join(tempDir, 'foo.onnx'), 'fake');
    writeFileSync(
      join(tempDir, 'foo.onnx.json'),
      JSON.stringify({ dataset: 'testset', quality: 'medium', language: { name_english: 'English' } }),
    );
    expect(listInstalledVoices()).toEqual([
      { id: 'foo', label: 'English · testset · medium', installed: true },
    ]);
  });

  it('catalogueVoices marks a voice installed once its .onnx exists', () => {
    writeFileSync(join(tempDir, 'en_US-lessac-medium.onnx'), 'fake');
    const voices = catalogueVoices();
    const lessac = voices.find((v) => v.id === 'en_US-lessac-medium');
    expect(lessac?.installed).toBe(true);
    const amy = voices.find((v) => v.id === 'en_US-amy-medium');
    expect(amy?.installed).toBe(false);
  });

  it("downloadVoice rejects unknown id with 'unknown voice'", async () => {
    await expect(
      downloadVoice('does-not-exist', () => {}),
    ).rejects.toThrow("unknown voice 'does-not-exist'");
  });
});
