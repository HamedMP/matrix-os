import { describe, expect, it, vi } from 'vitest';
import type { PlatformDb } from '../../packages/gateway/src/platform-db.js';
import { CustomMcpBroker } from '../../packages/gateway/src/integrations/custom-mcp/broker.js';
import { encryptCustomMcpCredential } from '../../packages/gateway/src/integrations/custom-mcp/crypto.js';

function fixture(withEndpoint = true) {
  const userId = 'owner_uuid';
  const serverId = '11111111-1111-4111-8111-111111111111';
  const key = Buffer.alloc(32);
  const credential = { oauth: { refreshToken: 'private_refresh', clientId: 'client',
    ...(withEndpoint ? { revocationEndpoint: 'https://oauth.example.test/revoke' } : {}) } };
  const row = { id: serverId, user_id: userId, auth_mode: 'oauth', revision: 1, enabled: true, status: 'ready',
    encrypted_credentials: encryptCustomMcpCredential(credential, key, { userId, serverId }) };
  const db = {
    getCustomMcpServerForBroker: vi.fn(async (_id: string, owner: string) => owner === userId ? { ...row } : null),
    claimCustomMcpRemovalIfCurrent: vi.fn(async (_id: string, owner: string, revision: number, expected: string | null, encrypted: string | null) => {
      if (owner !== userId || revision !== row.revision || row.encrypted_credentials !== expected) return false;
      Object.assign(row, { encrypted_credentials: encrypted, revision: revision + 1, enabled: false, status: 'disabled' });
      return true;
    }),
    updateCustomMcpServer: vi.fn(async (_id: string, _owner: string, revision: number, patch: object) => {
      if (revision !== row.revision) return null;
      Object.assign(row, patch, { revision: row.revision + 1 });
      return { ...row };
    }),
    deleteCustomMcpServerIfRevision: vi.fn(async (_id: string, _owner: string, revision: number) => revision === row.revision),
  };
  const projection = { upsert: vi.fn(), remove: vi.fn(async () => { throw Error('runtime destroyed'); }) };
  const revokeOAuth = vi.fn(async () => undefined);
  const broker = new CustomMcpBroker({ db: db as unknown as PlatformDb, encryptionKey: key, projection, revokeOAuth });
  return { broker, db, row, projection, revokeOAuth, userId, serverId, credential };
}

describe('Custom MCP account deletion revocation', () => {
  it('revokes using stored credentials after the runtime is destroyed without projection delivery', async () => {
    const f = fixture();
    await f.broker.removeForAccountDeletion(f.userId, f.serverId);
    expect(f.revokeOAuth).toHaveBeenCalledWith(f.credential);
    expect(f.projection.remove).not.toHaveBeenCalled();
    expect(f.db.deleteCustomMcpServerIfRevision).toHaveBeenCalledWith(f.serverId, f.userId, 2);
    await expect(f.broker.removeForAccountDeletion('foreign_owner', f.serverId)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('retains the encrypted grant on revocation failure and resumes successfully', async () => {
    const f = fixture();
    f.revokeOAuth.mockRejectedValueOnce(Error('remote unavailable'));
    await expect(f.broker.removeForAccountDeletion(f.userId, f.serverId)).rejects.toMatchObject({ code: 'action_required' });
    expect(f.db.deleteCustomMcpServerIfRevision).not.toHaveBeenCalled();
    expect(f.row.status).toBe('action_required');
    expect(f.row.encrypted_credentials).toEqual(expect.any(String));
    await f.broker.removeForAccountDeletion(f.userId, f.serverId);
    expect(f.revokeOAuth).toHaveBeenCalledTimes(2);
    expect(f.db.deleteCustomMcpServerIfRevision).toHaveBeenCalledOnce();
  });

  it('retains OAuth evidence when no revocation endpoint is available', async () => {
    const f = fixture(false);
    await expect(f.broker.removeForAccountDeletion(f.userId, f.serverId)).rejects.toMatchObject({ code: 'action_required' });
    expect(f.revokeOAuth).not.toHaveBeenCalled();
    expect(f.db.deleteCustomMcpServerIfRevision).not.toHaveBeenCalled();
  });

  it('keeps ordinary connection removal dependent on successful runtime projection', async () => {
    const f = fixture();
    await expect(f.broker.remove(f.userId,f.serverId)).rejects.toMatchObject({code:'action_required'});
    expect(f.projection.remove).toHaveBeenCalledWith(f.userId,f.serverId);
    expect(f.revokeOAuth).not.toHaveBeenCalled();
    expect(f.db.deleteCustomMcpServerIfRevision).not.toHaveBeenCalled();
  });
});
