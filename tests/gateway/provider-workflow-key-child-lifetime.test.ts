import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn }));
import { createCodexKeySaver } from '../../packages/gateway/src/ai-providers/provider-workflow-key.js';

it('kills and reaps a child with a failed stdin before removing its staging directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-child-lifetime-'));
  const child = Object.assign(new EventEmitter(), {
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
    stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(() => true),
  });
  spawn.mockReturnValue(child);
  let settled = false;
  try {
    const saving = createCodexKeySaver({ homePath: home })('sk-synthetic-fixture');
    const result = saving.catch(error => { settled = true; return error; });
    await vi.waitFor(() => expect(child.stdin.end).toHaveBeenCalled());
    child.stdin.emit('error', new Error('synthetic pipe failure'));
    await new Promise(resolve => setImmediate(resolve));
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(settled).toBe(false);
    expect((await readdir(join(home, '.codex'))).some(name => name.startsWith('.matrix-key-'))).toBe(true);
    child.emit('close', null);
    expect(await result).toBeInstanceOf(Error);
    expect((await readdir(join(home, '.codex'))).filter(name => name.startsWith('.matrix-key-'))).toEqual([]);
  } finally { child.emit('close', null); await rm(home, { recursive: true, force: true }); }
});
