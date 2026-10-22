import { afterEach, describe, expect, it } from 'vitest';
import { createBotStateDatabase } from './bot-state-support.js';
import { createBotProviderConnections } from '../../../packages/gateway/src/bots/provider-connections.js';

describe('owner Bot execution connections', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
  async function fixture() {
    const test = await createBotStateDatabase(); cleanups.push(test.destroy);
    let fingerprint = 'profile-a';
    const service = createBotProviderConnections({ db: test.db, ownerId: 'owner', computerId: 'computer-a',
      agentExists: async (owner, id) => owner === 'owner' && id === 'bot_test1234',
      observeClaude: async () => ({ available: true as const, fingerprint, models: [{ id: 'claude-observed', displayName: 'Observed model' }] }),
    });
    return { service, switchAccount: () => { fingerprint = 'profile-b'; } };
  }
  it('leaves provider-gated SIWC unavailable and never permits enabling it', async () => {
    const { service } = await fixture();
    expect((await service.connections('owner')).connections[0]).toMatchObject({ id: 'matrix_chatgpt_plan', availability: 'unavailable', unavailableReason: 'provider_access_required' });
    await expect(service.authorize('owner', 'matrix_chatgpt_plan', { baseRevision: 0, enabled: true, background: false })).rejects.toThrow('unavailable');
    await expect(service.connections('collaborator')).rejects.toThrow('forbidden');
  });
  it('revision-fences grants and selection and rechecks profile identity', async () => {
    const { service, switchAccount } = await fixture();
    await service.authorize('owner', 'claude_code_tasks', { baseRevision: 0, enabled: true, background: false });
    expect(await service.configure('owner', 'bot_test1234', { baseRevision: 0, connectionId: 'claude_code_tasks', model: 'claude-observed' })).toMatchObject({ revision: 1, grantRevision: 1 });
    expect(await service.admit('owner', 'bot_test1234', 'interactive')).toMatchObject({ model: 'claude-observed' });
    await expect(service.admit('owner', 'bot_test1234', 'background')).rejects.toThrow('forbidden');
    await expect(service.configure('owner', 'bot_test1234', { baseRevision: 0, connectionId: null })).rejects.toThrow('conflict');
    await expect(service.authorize('owner', 'claude_code_tasks', { baseRevision: 0, enabled: false, background: false })).rejects.toThrow('conflict');
    switchAccount();
    await expect(service.admit('owner', 'bot_test1234', 'interactive')).rejects.toThrow('unavailable');
    expect((await service.connections('owner')).connections[1]!.authorization.enabled).toBe(false);
  });
  it('revokes already saved executors without deleting bindings or enabling another source', async () => {
    const { service } = await fixture();
    await service.authorize('owner', 'claude_code_tasks', { baseRevision: 0, enabled: true, background: true });
    await service.configure('owner', 'bot_test1234', { baseRevision: 0, connectionId: 'claude_code_tasks', model: 'claude-observed' });
    await service.authorize('owner', 'claude_code_tasks', { baseRevision: 1, enabled: false, background: false });
    expect(await service.execution('owner', 'bot_test1234')).toMatchObject({ connectionId: 'claude_code_tasks' });
    await expect(service.admit('owner', 'bot_test1234', 'interactive')).rejects.toThrow('unavailable');
    await expect(service.configure('owner', 'bot_test1234', { baseRevision: 1, connectionId: 'claude_code_tasks', model: 'claude-invented' })).rejects.toThrow('unavailable');
    await expect(service.execution('owner', 'bot_foreign12')).rejects.toThrow('not_found');
  });
});
