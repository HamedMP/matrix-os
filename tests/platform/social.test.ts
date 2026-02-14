import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createPlatformDb, type PlatformDB, insertContainer } from '../../packages/platform/src/db.js';
import { createSocialApi } from '../../packages/platform/src/social.js';

describe('platform/social', () => {
  let tmpDir: string;
  let db: PlatformDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'platform-social-'));
    db = createPlatformDb(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists users with status', () => {
    insertContainer(db, { handle: 'alice', clerkUserId: 'c1', containerId: 'ctr1', port: 4001, shellPort: 3001, status: 'running' });
    insertContainer(db, { handle: 'bob', clerkUserId: 'c2', containerId: 'ctr2', port: 4002, shellPort: 3002, status: 'stopped' });

    const social = createSocialApi(db);
    const users = social.listUsers();

    expect(users).toHaveLength(2);
    expect(users[0].handle).toBe('bob');  // DESC order
    expect(users[1].handle).toBe('alice');
    expect(users[1].status).toBe('running');
  });

  it('returns null for unknown handle profile', async () => {
    const social = createSocialApi(db);
    const profile = await social.getProfile('ghost');
    expect(profile).toBeNull();
  });

  it('returns null for unknown handle ai-profile', async () => {
    const social = createSocialApi(db);
    const profile = await social.getAiProfile('ghost');
    expect(profile).toBeNull();
  });

  it('returns null when container profile fetch fails', async () => {
    insertContainer(db, { handle: 'alice', clerkUserId: 'c1', containerId: 'ctr1', port: 49999, shellPort: 49998, status: 'running' });

    const social = createSocialApi(db);
    // Port 49999 has nothing listening -- fetch will fail
    const profile = await social.getProfile('alice');
    expect(profile).toBeNull();
  });

  it('throws when sending message to unknown handle without proxy', async () => {
    const social = createSocialApi(db);
    await expect(
      social.sendMessage('ghost', 'hello', { handle: 'alice' })
    ).rejects.toThrow('No container');
  });
});
