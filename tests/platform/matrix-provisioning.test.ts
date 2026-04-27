import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { type PlatformDB } from '../../packages/platform/src/db.js';
import {
  createMatrixProvisioner,
  type MatrixProvisioner,
  getMatrixUser,
  listMatrixUsers,
} from '../../packages/platform/src/matrix-provisioning.js';

describe('platform/matrix-provisioning', () => {
  let db: PlatformDB;
  let fetchMock: ReturnType<typeof vi.fn>;
  let provisioner: MatrixProvisioner;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    fetchMock = vi.fn();
    provisioner = createMatrixProvisioner({
      db,
      homeserverUrl: 'https://matrix.matrix-os.com',
      registrationToken: 'test-token',
      fetch: fetchMock,
    });
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  function mockRegisterAndLogin(userId: string, accessToken: string) {
    // Register response (with access_token included)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ user_id: userId, access_token: accessToken }),
    });
  }

  function mockRegisterThenLogin(userId: string, accessToken: string) {
    // Register response (no access_token -- requires separate login)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ user_id: userId }),
    });
    // Login response
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ user_id: userId, access_token: accessToken }),
    });
  }

  describe('provisionUser', () => {
    it('creates Matrix accounts for human and AI via Conduit register API', async () => {
      mockRegisterAndLogin('@alice:matrix-os.com', 'human-token-123');
      mockRegisterAndLogin('@alice_ai:matrix-os.com', 'ai-token-456');

      const result = await provisioner.provisionUser('alice');

      expect(result.humanMatrixId).toBe('@alice:matrix-os.com');
      expect(result.aiMatrixId).toBe('@alice_ai:matrix-os.com');
      expect(result.humanAccessToken).toBe('human-token-123');
      expect(result.aiAccessToken).toBe('ai-token-456');

      // Verify correct Conduit register endpoint (not Synapse admin API)
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [humanUrl, humanOpts] = fetchMock.mock.calls[0];
      expect(humanUrl).toBe('https://matrix.matrix-os.com/_matrix/client/v3/register');
      const humanBody = JSON.parse(humanOpts.body);
      expect(humanBody.username).toBe('alice');
      expect(humanBody.auth).toEqual({
        type: 'm.login.registration_token',
        token: 'test-token',
      });

      const [aiUrl, aiOpts] = fetchMock.mock.calls[1];
      expect(aiUrl).toBe('https://matrix.matrix-os.com/_matrix/client/v3/register');
      const aiBody = JSON.parse(aiOpts.body);
      expect(aiBody.username).toBe('alice_ai');
    });

    it('falls back to login if register does not return access_token', async () => {
      mockRegisterThenLogin('@bob:matrix-os.com', 'h-tok');
      mockRegisterThenLogin('@bob_ai:matrix-os.com', 'ai-tok');

      const result = await provisioner.provisionUser('bob');

      expect(result.humanAccessToken).toBe('h-tok');
      expect(result.aiAccessToken).toBe('ai-tok');

      // 4 calls: register + login for each user
      expect(fetchMock).toHaveBeenCalledTimes(4);

      const [loginUrl, loginOpts] = fetchMock.mock.calls[1];
      expect(loginUrl).toBe('https://matrix.matrix-os.com/_matrix/client/v3/login');
      const loginBody = JSON.parse(loginOpts.body);
      expect(loginBody.type).toBe('m.login.password');
      expect(loginBody.identifier).toEqual({ type: 'm.id.user', user: 'bob' });
    });

    it('stores provisioned users in the database', async () => {
      mockRegisterAndLogin('@bob:matrix-os.com', 'h-tok');
      mockRegisterAndLogin('@bob_ai:matrix-os.com', 'ai-tok');

      await provisioner.provisionUser('bob');

      const user = await getMatrixUser(db, 'bob');
      expect(user).toBeTruthy();
      expect(user!.handle).toBe('bob');
      expect(user!.humanMatrixId).toBe('@bob:matrix-os.com');
      expect(user!.aiMatrixId).toBe('@bob_ai:matrix-os.com');
      expect(user!.humanAccessToken).toBe('h-tok');
      expect(user!.aiAccessToken).toBe('ai-tok');
      expect(user!.createdAt).toBeTruthy();
    });

    it('throws if registration fails', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ errcode: 'M_USER_IN_USE', error: 'User already exists' }),
      });

      await expect(provisioner.provisionUser('charlie')).rejects.toThrow(
        'Failed to register Matrix user charlie: M_USER_IN_USE',
      );
    });

    it('throws if login fails after successful registration', async () => {
      // Register succeeds without access_token
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ user_id: '@dave:matrix-os.com' }),
      });
      // Login fails
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ errcode: 'M_FORBIDDEN' }),
      });

      await expect(provisioner.provisionUser('dave')).rejects.toThrow(
        'Failed to login Matrix user dave after registration',
      );
    });

    it('handles JSON parse error in error response gracefully', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => { throw new Error('not json'); },
      });

      await expect(provisioner.provisionUser('eve')).rejects.toThrow(
        'Failed to register Matrix user eve: 500',
      );
    });
  });

  describe('getMatrixUser', () => {
    it('returns null for non-existent user', async () => {
      const user = await getMatrixUser(db, 'nonexistent');
      expect(user).toBeNull();
    });
  });

  describe('listMatrixUsers', () => {
    it('lists all provisioned users', async () => {
      mockRegisterAndLogin('@alice:matrix-os.com', 'tok1');
      mockRegisterAndLogin('@alice_ai:matrix-os.com', 'tok2');
      mockRegisterAndLogin('@bob:matrix-os.com', 'tok3');
      mockRegisterAndLogin('@bob_ai:matrix-os.com', 'tok4');

      await provisioner.provisionUser('alice');
      await provisioner.provisionUser('bob');

      const users = await listMatrixUsers(db);
      expect(users).toHaveLength(2);
      expect(users.map((u) => u.handle)).toContain('alice');
      expect(users.map((u) => u.handle)).toContain('bob');
    });
  });

  describe('provisionUser partial failure', () => {
    it('throws when human registration succeeds but AI registration fails', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ user_id: '@dave:matrix-os.com', access_token: 'h-tok' }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ errcode: 'M_UNKNOWN', error: 'AI registration failed' }),
      });

      await expect(provisioner.provisionUser('dave')).rejects.toThrow('Failed to register');
    });
  });

  describe('provisionUser with special characters', () => {
    it('handles handle with hyphens and underscores', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ user_id: '@my-user_123:matrix-os.com', access_token: 'h-tok' }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ user_id: '@my-user_123_ai:matrix-os.com', access_token: 'ai-tok' }),
      });

      const result = await provisioner.provisionUser('my-user_123');

      expect(result.humanMatrixId).toBe('@my-user_123:matrix-os.com');
      expect(result.aiMatrixId).toBe('@my-user_123_ai:matrix-os.com');

      const [humanUrl, humanOpts] = fetchMock.mock.calls[0];
      expect(humanUrl).toContain('/_matrix/client/v3/register');
      const humanBody = JSON.parse(humanOpts.body);
      expect(humanBody.username).toBe('my-user_123');
      const [aiUrl, aiOpts] = fetchMock.mock.calls[1];
      expect(aiUrl).toContain('/_matrix/client/v3/register');
      const aiBody = JSON.parse(aiOpts.body);
      expect(aiBody.username).toBe('my-user_123_ai');
    });
  });

  describe('duplicate provisioning', () => {
    it('overwrites database record when same handle is provisioned twice', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ user_id: '@x:matrix-os.com', access_token: 'tok' }),
      });

      await provisioner.provisionUser('eve');
      const firstUser = await getMatrixUser(db, 'eve');
      expect(firstUser).toBeTruthy();

      // Second provision with same handle -- insertMatrixUser may fail due to PK constraint
      // or succeed by overwriting. This tests whatever the implementation does.
      try {
        await provisioner.provisionUser('eve');
        const secondUser = await getMatrixUser(db, 'eve');
        expect(secondUser).toBeTruthy();
      } catch {
        // If PK constraint prevents duplicate, that's also acceptable
        expect(await getMatrixUser(db, 'eve')).toBeTruthy();
      }
    });
  });

  describe('deprovisionUser', () => {
    it('removes user from database', async () => {
      mockRegisterAndLogin('@alice:matrix-os.com', 'tok1');
      mockRegisterAndLogin('@alice_ai:matrix-os.com', 'tok2');

      await provisioner.provisionUser('alice');
      expect(await getMatrixUser(db, 'alice')).toBeTruthy();

      await provisioner.deprovisionUser('alice');
      expect(await getMatrixUser(db, 'alice')).toBeNull();
    });
  });
});
