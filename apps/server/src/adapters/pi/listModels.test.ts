import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { PiAdapter } from './index.js';

/**
 * Fake ChildProcess shape matching what PiAdapter.listModels touches:
 * stdin (closed by adapter to signal EOF), stdout (we push the table in),
 * kill(), and EventEmitter for 'error' / 'close'.
 */
function fakeChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    kill: (signal?: string) => void;
  };
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.kill = (_sig?: string) => {};
  return proc;
}

describe('PiAdapter.listModels', () => {
  it('parses a header + 2 row table into 2 descriptors', async () => {
    const stdout = [
      'provider  model                   context  max-out  thinking  images',
      'lmstudio  google/gemma-4-12b      262.1K   16.4K    no        no',
      'zai       glm-5.2                 1M       131.1K   yes       no',
    ].join('\n') + '\n';

    const child = fakeChild();
    const adapter = new PiAdapter({
      bin: 'pi',
      spawnFn: () => {
        Promise.resolve().then(() => {
          child.stdout.write(stdout);
          child.stdout.end();
          child.emit('close', 0);
        });
        return child as never;
      },
    });

    const models = await adapter.listModels();

    expect(models).toHaveLength(2);

    expect(models[0]).toMatchObject({
      name: 'lmstudio/google/gemma-4-12b',
      label: 'Pi · google/gemma-4-12b',
      provider: 'lmstudio',
      vision: false,
      steer: true,
      contextWindow: 262_100,
    });

    expect(models[1]).toMatchObject({
      name: 'zai/glm-5.2',
      label: 'Pi · glm-5.2',
      provider: 'zai',
      vision: false,
      steer: true,
      contextWindow: 1_000_000,
    });
  });

  it('parses token-count suffixes: K, M, and decimals', async () => {
    const stdout = [
      'provider  model              context  max-out  thinking  images',
      'zai       glm-5.1            200K     131.1K   yes       no',
      'zai       glm-5.2            1M       131.1K   yes       no',
      'lmstudio  gemma-4-12b        262.1K   16.4K    no        yes',
    ].join('\n') + '\n';

    const child = fakeChild();
    const adapter = new PiAdapter({
      spawnFn: () => {
        Promise.resolve().then(() => {
          child.stdout.write(stdout);
          child.stdout.end();
          child.emit('close', 0);
        });
        return child as never;
      },
    });

    const models = await adapter.listModels();
    expect(models.map((m) => m.contextWindow)).toEqual([200_000, 1_000_000, 262_100]);
  });

  it('flags vision=true when images column is "yes"', async () => {
    const stdout = [
      'provider  model       context  max-out  thinking  images',
      'zai       glm-4.7     200K     131.1K   no        yes',
    ].join('\n') + '\n';

    const child = fakeChild();
    const adapter = new PiAdapter({
      spawnFn: () => {
        Promise.resolve().then(() => {
          child.stdout.write(stdout);
          child.stdout.end();
          child.emit('close', 0);
        });
        return child as never;
      },
    });

    const [model] = await adapter.listModels();
    expect(model?.vision).toBe(true);
    expect(model?.steer).toBe(true);
  });

  it('reports vision=false when images column is "no" (no model-name override)', async () => {
    // Vision capability is sourced entirely from pi's `images` column. There is
    // no longer any name-based override for local Gemma variants — fix the
    // metadata in ~/.pi/agent/models.json instead.
    const stdout = [
      'provider  model                   context  max-out  thinking  images',
      'lmstudio  google/gemma-4-12b      262.1K   16.4K    no        no',
      'lmstudio  gemma-4-26b-a4b         524.2K   32.8K    no        no',
      'zai       glm-5.2                 1M       131.1K   yes       no',
    ].join('\n') + '\n';

    const child = fakeChild();
    const adapter = new PiAdapter({
      spawnFn: () => {
        Promise.resolve().then(() => {
          child.stdout.write(stdout);
          child.stdout.end();
          child.emit('close', 0);
        });
        return child as never;
      },
    });

    const models = await adapter.listModels();
    expect(models[0]?.vision).toBe(false);  // google/gemma-4-12b — no in images column
    expect(models[1]?.vision).toBe(false);  // gemma-4-26b-a4b — no in images column
    expect(models[2]?.vision).toBe(false);  // glm-5.2 — no in images column
  });

  it('resolves to [] when stdout is empty', async () => {
    const child = fakeChild();
    const adapter = new PiAdapter({
      spawnFn: () => {
        Promise.resolve().then(() => {
          child.stdout.end();
          child.emit('close', 0);
        });
        return child as never;
      },
    });

    expect(await adapter.listModels()).toEqual([]);
  });

  it('resolves to [] when only the header line is present', async () => {
    const child = fakeChild();
    const adapter = new PiAdapter({
      spawnFn: () => {
        Promise.resolve().then(() => {
          child.stdout.write('provider  model  context  max-out  thinking  images\n');
          child.stdout.end();
          child.emit('close', 0);
        });
        return child as never;
      },
    });

    expect(await adapter.listModels()).toEqual([]);
  });

  it('rejects when the subprocess exits non-zero', async () => {
    const child = fakeChild();
    const adapter = new PiAdapter({
      spawnFn: () => {
        Promise.resolve().then(() => {
          child.emit('close', 1);
        });
        return child as never;
      },
    });

    await expect(adapter.listModels()).rejects.toThrow(/exited with code 1/);
  });

  it('rejects when the subprocess emits an error event', async () => {
    const child = fakeChild();
    const adapter = new PiAdapter({
      spawnFn: () => {
        Promise.resolve().then(() => {
          child.emit('error', new Error('spawn ENOENT: pi not found'));
        });
        return child as never;
      },
    });

    await expect(adapter.listModels()).rejects.toThrow('spawn ENOENT: pi not found');
  });

  it('skips malformed rows that do not yield 6 columns', async () => {
    // A model name with embedded "  " would be mis-tokenised; pi's own formatter
    // never emits such rows, but the parser should skip rather than crash.
    const stdout = [
      'provider  model       context  max-out  thinking  images',
      'garbage row with too few columns',
      'zai       glm-5.2     1M       131.1K   yes       no',
    ].join('\n') + '\n';

    const child = fakeChild();
    const adapter = new PiAdapter({
      spawnFn: () => {
        Promise.resolve().then(() => {
          child.stdout.write(stdout);
          child.stdout.end();
          child.emit('close', 0);
        });
        return child as never;
      },
    });

    const models = await adapter.listModels();
    expect(models).toHaveLength(1);
    expect(models[0]?.name).toBe('zai/glm-5.2');
  });
});
