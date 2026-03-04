import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createPlatformDb, type PlatformDB } from '../../packages/platform/src/db.js';
import {
  createMatrixProvisioner,
  type MatrixProvisioner,
  getMatrixUser,
  listMatrixUsers,
} from '../../packages/platform/src/matrix-provisioning.js';

describe('platform/matrix-provisioning', () => {
  let tmpDir: string;
  let db: PlatformDB;
  let fetchMock: ReturnType<typeof vi.fn>;
  let provisioner: MatrixProvisioner;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'matrix-prov-'));
    db = createPlatformDb(join(tmpDir, 'test.db'));
    fetchMock = vi.fn();
    provisioner = createMatrixProvisioner({
      db,
      homeserverUrl: 'https://matrix.matrix-os.com',
      adminToken: 'admin-secret',
      fetch: fetchMock,
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('provisionUser', () => {
    it('creates Matrix accounts for human and AI handles', async () => {
      // Register human user
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          user_id: '@alice:matrix-os.com',
          access_token: 'human-token-123',
        }),
      });
      // Register AI user
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          user_id: '@alice_ai:matrix-os.com',
          access_token: 'ai-token-456',
        }),
      });

      const result = await provisioner.provisionUser('alice');

      expect(result.humanMatrixId).toBe('@alice:matrix-os.com');
      expect(result.aiMatrixId).toBe('@alice_ai:matrix-os.com');
      expect(result.humanAccessToken).toBe('human-token-123');
      expect(result.aiAccessToken).toBe('ai-token-456');

      // Verify API calls
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [humanUrl, humanOpts] = fetchMock.mock.calls[0];
      expect(humanUrl).toContain('/_synapse/admin/v2/users/@alice:matrix-os.com');
      const humanBody = JSON.parse(humanOpts.body);
      expect(humanBody.displayname).toBe('alice');

      const [aiUrl] = fetchMock.mock.calls[1];
      expect(aiUrl).toContain('/_synapse/admin/v2/users/@alice_ai:matrix-os.com');
    });

    it('stores provisioned users in the database', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ user_id: '@bob:matrix-os.com', access_token: 'h-tok' }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ user_id: '@bob_ai:matrix-os.com', access_token: 'ai-tok' }),
      });

      await provisioner.provisionUser('bob');

      const user = getMatrixUser(db, 'bob');
      expect(user).toBeTruthy();
      expect(user!.handle).toBe('bob');
      expect(user!.humanMatrixId).toBe('@bob:matrix-os.com');
      expect(user!.aiMatrixId).toBe('@bob_ai:matrix-os.com');
    });

    it('throws if admin API registration fails', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ errcode: 'M_UNKNOWN', error: 'Internal error' }),
      });

      await expect(provisioner.provisionUser('charlie')).rejects.toThrow('Failed to provision');
    });
  });

  describe('getMatrixUser', () => {
    it('returns null for non-existent user', () => {
      const user = getMatrixUser(db, 'nonexistent');
      expect(user).toBeNull();
    });
  });

  describe('listMatrixUsers', () => {
    it('lists all provisioned users', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ user_id: '@x:matrix-os.com', access_token: 'tok' }),
      });

      await provisioner.provisionUser('alice');
      await provisioner.provisionUser('bob');

      const users = listMatrixUsers(db);
      expect(users).toHaveLength(2);
      expect(users.map((u) => u.handle)).toContain('alice');
      expect(users.map((u) => u.handle)).toContain('bob');
    });
  });

  describe('deprovisionUser', () => {
    it('removes user from database', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ user_id: '@x:matrix-os.com', access_token: 'tok' }),
      });

      await provisioner.provisionUser('alice');
      expect(getMatrixUser(db, 'alice')).toBeTruthy();

      provisioner.deprovisionUser('alice');
      expect(getMatrixUser(db, 'alice')).toBeNull();
    });
  });
});
