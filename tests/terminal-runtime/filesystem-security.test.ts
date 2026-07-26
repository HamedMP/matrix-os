import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DescriptorStore } from '../../packages/terminal-runtime/src/descriptors.js';
import { FlockManager } from '../../packages/terminal-runtime/src/locks.js';
import { validateKeeperCwd } from '../../packages/terminal-runtime/src/keeper.js';
import { SecureDirectory } from '../../packages/terminal-runtime/src/storage.js';
const RUNTIME_ID = '0123456789abcdef0123456789abcdef';
const OPERATION_ID = 'fedcba9876543210fedcba9876543210';
const NOW_MS = Date.parse('2026-07-26T00:00:00.000Z');
function descriptor(operationId = OPERATION_ID) {
  return {
    schemaVersion: 1 as const,
    runtimeId: RUNTIME_ID,
    operationId,
    intent: 'create' as const,
    cwd: { kind: 'home-relative' as const, path: 'projects/matrix' },
    launch: { kind: 'shell' as const },
    createdAt: new Date(NOW_MS).toISOString(),
  };
}
describe('terminal runtime filesystem security', () => {
  it('pins a real 0700 parent and rejects symlink parents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matrix-terminal-pinned-'));
    const real = join(root, 'real');
    const linked = join(root, 'linked');
    try {
      await mkdir(real, { mode: 0o700 });
      await symlink(real, linked);
      await expect(SecureDirectory.open(linked)).rejects.toThrow('unsafe_parent');
      const directory = await SecureDirectory.open(real);
      try {
        const mode = (await lstat(real)).mode & 0o777;
        expect(mode).toBe(0o700);
      } finally {
        await directory.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('revalidates keeper cwd against symlink escape immediately before launch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matrix-terminal-cwd-'));
    const home = join(root, 'home');
    const project = join(home, 'project');
    const outside = join(root, 'outside');
    try {
      await mkdir(project, { recursive: true });
      await mkdir(outside);
      await symlink(outside, join(home, 'escape'));
      await expect(validateKeeperCwd(home, 'project')).resolves.toBe(project);
      await expect(validateKeeperCwd(home, 'escape')).rejects.toThrow(
        'keeper_cwd_invalid',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('fails safely on symlink and hard-link replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matrix-terminal-links-'));
    const parent = join(root, 'state');
    const external = join(root, 'external.json');
    try {
      await mkdir(parent, { mode: 0o700 });
      await writeFile(external, '{}', { mode: 0o600 });
      const directory = await SecureDirectory.open(parent);
      try {
        await symlink(external, join(parent, 'symlink.json'));
        await expect(directory.readJson('symlink.json', 1024)).rejects.toThrow(
          'unsafe_file',
        );
        await link(external, join(parent, 'hardlink.json'));
        await expect(directory.readJson('hardlink.json', 1024)).rejects.toThrow(
          'unsafe_file',
        );
      } finally {
        await directory.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('never follows a replaced lock file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matrix-terminal-lock-link-'));
    const lockRoot = join(root, 'locks');
    const external = join(root, 'external');
    let locks: FlockManager | undefined;
    try {
      await mkdir(lockRoot, { mode: 0o700 });
      await writeFile(external, 'unchanged', { mode: 0o600 });
      await symlink(external, join(lockRoot, 'name-index.lock'));
      locks = await FlockManager.open(lockRoot);
      await expect(
        locks.withNameIndex(async () => undefined),
      ).rejects.toBeInstanceOf(Error);
      await expect(readFile(external, 'utf8')).resolves.toBe('unchanged');
    } finally {
      await locks?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('holds the kernel flock for the full runtime critical section', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matrix-terminal-lock-held-'));
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const secondEntered = Promise.withResolvers<void>();
    let locks: FlockManager | undefined;
    try {
      locks = await FlockManager.open(root);
      const first = locks.withRuntime(RUNTIME_ID, false, async () => {
        firstEntered.resolve();
        await releaseFirst.promise;
      });
      await firstEntered.promise;
      expect(await locks.isRuntimeLocked(RUNTIME_ID)).toBe(true);
      const second = locks.withRuntime(RUNTIME_ID, false, async () => {
        secondEntered.resolve();
      });
      const raced = await Promise.race([
        secondEntered.promise.then(() => 'entered'),
        new Promise<'waiting'>((resolve) =>
          setTimeout(() => resolve('waiting'), 50),
        ),
      ]);
      expect(raced).toBe('waiting');
      releaseFirst.resolve();
      await Promise.all([first, second]);
      expect(await locks.isRuntimeLocked(RUNTIME_ID)).toBe(false);
    } finally {
      releaseFirst.resolve();
      await locks?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('publishes exclusively, fsyncs, and never overwrites an existing target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matrix-terminal-exclusive-'));
    try {
      await chmod(root, 0o700);
      const directory = await SecureDirectory.open(root);
      try {
        await directory.createJsonExclusive('record.json', { value: 1 });
        await expect(
          directory.createJsonExclusive('record.json', { value: 2 }),
        ).rejects.toThrow('state_conflict');
        expect(JSON.parse(await readFile(join(root, 'record.json'), 'utf8'))).toEqual({
          value: 1,
        });
        expect((await lstat(join(root, 'record.json'))).mode & 0o777).toBe(0o600);
      } finally {
        await directory.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('claims descriptors once, unlinks immediately, and enforces caller authorization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matrix-terminal-descriptor-'));
    try {
      await chmod(root, 0o700);
      const directory = await SecureDirectory.open(root);
      const store = new DescriptorStore(directory, {
        authorizeClaim: async ({ runtimeId, pid }) =>
          runtimeId === RUNTIME_ID && pid === 4242,
        nowMs: () => NOW_MS,
      });
      try {
        await store.publish(descriptor());
        await expect(
          store.claim({ runtimeId: RUNTIME_ID, operationId: OPERATION_ID, pid: 1 }),
        ).rejects.toThrow('claim_unauthorized');
        await expect(
          store.claimRuntime({ runtimeId: RUNTIME_ID, pid: 4242 }),
        ).resolves.toEqual(descriptor());
        await expect(
          store.claimRuntime({ runtimeId: RUNTIME_ID, pid: 4242 }),
        ).rejects.toThrow('descriptor_not_found');
        const replacedId = '11111111111111111111111111111111';
        const external = join(root, 'external.json');
        const pending = join(root, `${RUNTIME_ID}.${replacedId}.pending.json`);
        await writeFile(external, '{}', { mode: 0o600 });
        await store.publish(descriptor(replacedId));
        await rm(pending);
        await symlink(external, pending);
        await expect(
          store.claim({ runtimeId: RUNTIME_ID, operationId: replacedId, pid: 4242 }),
        ).rejects.toThrow('unsafe_file');
        await expect(readFile(external, 'utf8')).resolves.toBe('{}');
        await rm(pending);
        await rm(external);
        const expiredId = '22222222222222222222222222222222';
        await directory.replaceJson(`${RUNTIME_ID}.${expiredId}.pending.json`, {
          ...descriptor(expiredId),
          createdAt: new Date(NOW_MS - 11 * 60 * 1000).toISOString(),
        });
        await expect(store.claim({
          runtimeId: RUNTIME_ID, operationId: expiredId, pid: 4242,
        })).rejects.toThrow('descriptor_expired');
        expect(await directory.list()).toEqual([]);
      } finally {
        await directory.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('enforces descriptor size/count limits and sweeps only proven stale files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matrix-terminal-descriptor-caps-'));
    try {
      await chmod(root, 0o700);
      const directory = await SecureDirectory.open(root);
      const store = new DescriptorStore(directory, {
        authorizeClaim: async () => true,
        nowMs: () => NOW_MS,
        maxPending: 2,
        ttlMs: 10 * 60 * 1000,
      });
      try {
        const secondId = '11111111111111111111111111111111';
        await store.publish(descriptor());
        await store.publish(descriptor(secondId));
        await expect(
          store.publish(descriptor('22222222222222222222222222222222')),
        ).rejects.toThrow('descriptor_capacity');
        const staleName = `${RUNTIME_ID}.${OPERATION_ID}.pending.json`;
        await directory.replaceJson(staleName, {
          ...descriptor(),
          createdAt: new Date(NOW_MS - 11 * 60 * 1000).toISOString(),
        });
        await directory.replaceJson('invalid.json', { value: 'not-a-descriptor' });
        const oversized = `33333333333333333333333333333333.44444444444444444444444444444444.pending.json`;
        await writeFile(join(root, oversized), 'x'.repeat(129 * 1024), { mode: 0o600 });
        await store.sweep({
          isActive: async () => false,
          isLocked: async ({ runtimeId }) => runtimeId === '33333333333333333333333333333333',
        });
        expect(await directory.list()).not.toContain(staleName);
        expect(await directory.list()).toContain('invalid.json');
        expect(await directory.list()).toContain(oversized);
      } finally {
        await directory.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
