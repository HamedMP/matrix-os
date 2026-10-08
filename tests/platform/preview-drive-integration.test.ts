import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KyselyPGlite } from 'kysely-pglite';
import { createPlatformDb, type PlatformDb } from '../../packages/gateway/src/platform-db.js';
import { createPreviewDriveIntegration } from '../../packages/platform/src/preview-drive-integration.js';

describe('Preview Drive owner connection execution', () => {
  let db: PlatformDb;
  let userId: string;
  beforeEach(async () => {
    const instance = await KyselyPGlite.create();
    db = createPlatformDb({ dialect: instance.dialect });
    await db.migrate();
    userId = (await db.ensureUser({ clerkId: 'actor-one', handle: 'owner-one', displayName: 'Owner',
      email: 'owner@example.com', containerId: 'owner-machine', pipedreamExternalId: 'external-one' })).id;
  });
  afterEach(async () => { await db.destroy(); });

  async function setup() {
    const original = await db.connectService({ userId, service: 'google_drive',
      pipedreamAccountId: 'provider-original', accountLabel: 'personal', scopes: [] });
    const executeAction = vi.fn(async () => ({ data: { files: [] } }));
    const integration = createPreviewDriveIntegration({ db, resolveUserId: async actor => actor === 'actor-one' ? userId : null,
      pipedream: {}, getService: () => ({ id: 'google_drive' }), getAction: () => ({ risk: 'read' }), executeAction });
    const binding = { connectionId: original.id, providerAccountId: original.pipedream_account_id, label: 'personal' };
    return { original, integration, binding, executeAction };
  }

  it('dispatches only the bound active owner connection', async () => {
    const { integration, binding, executeAction } = await setup();
    expect(await integration.listConnections('actor-one')).toMatchObject([{ id: binding.connectionId, pipedream_account_id: binding.providerAccountId }]);
    expect(await integration.execute('actor-one', binding, { maxResults: 3 })).toEqual({ files: [] });
    expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({ externalUserId: 'external-one',
      connection: expect.objectContaining({ id: binding.connectionId, pipedream_account_id: binding.providerAccountId }),
      serviceId: 'google_drive', actionId: 'list_files', params: { maxResults: 3 } }));
  });

  it('rejects a same-label replacement even if connection inventory changed immediately before dispatch', async () => {
    const { original, integration, binding, executeAction } = await setup();
    await db.disconnectService(original.id);
    await db.connectService({ userId, service: 'google_drive', pipedreamAccountId: 'provider-replacement', accountLabel: 'personal', scopes: [] });
    await expect(integration.execute('actor-one', binding, { maxResults: 3 })).rejects.toThrow('account unavailable');
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('rejects label changes and a forged provider account binding', async () => {
    const { original, integration, binding, executeAction } = await setup();
    await expect(integration.execute('actor-one', { ...binding, providerAccountId: 'provider-other' }, { maxResults: 3 })).rejects.toThrow('account unavailable');
    await db.updateAccountLabel(original.id, 'renamed');
    await expect(integration.execute('actor-one', binding, { maxResults: 3 })).rejects.toThrow('account unavailable');
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('rejects an account connection belonging to another actor', async () => {
    const { integration, binding, executeAction } = await setup();
    expect(await integration.listConnections('actor-other')).toEqual([]);
    await expect(integration.execute('actor-other', binding, { maxResults: 3 })).rejects.toThrow('account unavailable');
    expect(executeAction).not.toHaveBeenCalled();
  });
});
