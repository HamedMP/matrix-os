import { lstat, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAgentConfigurationStore,
} from '../../packages/terminal-runtime/src/agent-configurations.js';

const operationId = 'fedcba9876543210fedcba9876543210';
const roots: string[] = [];
const configuration = {
  schemaVersion: 1 as const,
  agent: 'claude' as const,
  cwd: { kind: 'home-relative' as const, path: 'projects/example' },
  prompt: 'private prompt',
  mode: 'plan' as const,
  approvalPolicy: 'on-request' as const,
  sandbox: {
    enabled: true,
    mode: 'workspace-write' as const,
    writableRoots: [
      { kind: 'home-relative' as const, path: 'projects/example' },
    ],
    denyWriteRoots: [],
  },
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe('terminal agent configuration store', () => {
  it('publishes exclusively at 0600 and unlinks immediately on claim', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'matrix-agent-config-'));
    roots.push(directory);
    const store = createAgentConfigurationStore({ directory });

    await store.publish(operationId, configuration);
    const path = join(directory, operationId);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).toContain('private prompt');
    await expect(store.publish(operationId, configuration)).rejects.toThrow();

    await expect(store.claim(operationId)).resolves.toEqual(configuration);
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a symlink without reading its target', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'matrix-agent-config-'));
    const target = join(directory, 'target');
    roots.push(directory);
    await symlink(target, join(directory, operationId));
    const store = createAgentConfigurationStore({ directory });

    await expect(store.claim(operationId)).rejects.toThrow(
      'agent_configuration_invalid',
    );
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
