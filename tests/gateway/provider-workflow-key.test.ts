import { describe, it, expect, vi } from 'vitest';
import { createProviderKeyVerifier } from '../../packages/gateway/src/ai-providers/provider-workflow-key.js';
describe('key verification boundary', () => {
  it('does not save rejected secrets or follow redirects', async () => {
    const save = vi.fn(); const fetchFn = vi.fn(async () => new Response('{}', { status: 401 }));
    const verify = createProviderKeyVerifier({ providerId: 'openai', save, fetchFn });
    await expect(verify({ harnessInstanceId: 'codex', providerId: 'openai', apiKey: 'sk-test-secret' })).rejects.toThrow('rejected');
    expect(save).not.toHaveBeenCalled(); expect(fetchFn.mock.calls[0]![1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
  });
  it('saves only after an accepted bounded probe', async () => {
    const save = vi.fn(async () => {});
    const verify = createProviderKeyVerifier({ providerId: 'openai', save, fetchFn: async () => new Response('{}') });
    await verify({ harnessInstanceId: 'codex', providerId: 'openai', apiKey: 'sk-test-secret' });
    expect(save).toHaveBeenCalledWith('sk-test-secret');
  });
});

import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexKeySaver } from '../../packages/gateway/src/ai-providers/provider-workflow-key.js';
it('isolates a failed native CLI saver and preserves the exact previous auth bytes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'key-save-')); const prefix = join(home, 'runtime');
  try {
    await mkdir(join(home, '.codex')); await mkdir(join(prefix, 'bin'), { recursive: true });
    await writeFile(join(home, '.codex/auth.json'), '{"old":"keep-exact"}\n');
    await writeFile(join(prefix, 'bin/codex'), '#!/bin/sh\ncat >/dev/null\nprintf "{}" > "$CODEX_HOME/auth.json"\nexit 1\n', { mode: 0o700 });
    await expect(createCodexKeySaver({ homePath: home, runtimePrefix: prefix })('sk-synthetic-fixture')).rejects.toThrow();
    expect(await readFile(join(home, '.codex/auth.json'), 'utf8')).toBe('{"old":"keep-exact"}\n');
    expect((await readdir(home)).filter(name => name.startsWith('.codex-key-'))).toEqual([]);
  } finally { await rm(home, { recursive: true, force: true }); }
});
