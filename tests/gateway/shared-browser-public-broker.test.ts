import { describe, expect, it, vi } from 'vitest';
import { createSharedBrowserBroker, SharedBrowserError } from '../../packages/gateway/src/shared-browser/broker.js';

const binding = { ownerId: 'owner', chatId: 'chat', runId: 'run', harness: 'claude_code' as const };
const signal = new AbortController().signal;
const openPublic = { action: 'tab_new', context: 'public', url: 'https://example.com/' } as const;

function driver(targetId: string) {
  return {
    execute: vi.fn(async () => ({ success: true, targetId, observationId: 'obs' })),
    invalidateObservation: vi.fn(),
    detach: vi.fn(async () => {}),
  };
}

describe('public Browser run binding', () => {
  it('keeps the selected driver for all later actions and Resume, without exposing it to another run', async () => {
    const owner = driver('owner-target'), publicDriver = driver('public-target');
    const broker = createSharedBrowserBroker({ ownerId: 'owner', driver: owner, publicDriver, setHumanControl: async () => {} });
    try {
      broker.openRun(binding, signal);
      await expect(broker.execute(binding, openPublic, signal)).resolves.toHaveProperty('targetId', 'public-target');
      await expect(broker.execute(binding, { action: 'tab_new', url: 'https://example.org/' }, signal)).resolves.toHaveProperty('targetId', 'public-target');
      await broker.control('owner', { action: 'takeover' });
      await broker.control('owner', { action: 'resume' });
      await expect(broker.execute(binding, { action: 'snapshot' }, signal)).resolves.toHaveProperty('targetId', 'public-target');
      await expect(broker.execute(binding, { action: 'download', observationId: 'obs', ref: 'r1', documentId: '1' }, signal)).rejects.toMatchObject({ code: 'invalid_action' });
      expect(publicDriver.execute).toHaveBeenCalledTimes(3);
      expect(publicDriver.detach).toHaveBeenCalledOnce();
      expect(owner.execute).not.toHaveBeenCalled();
      await broker.closeRun(binding.runId);

      const next = { ...binding, runId: 'next' };
      broker.openRun(next, signal);
      await expect(broker.execute(next, { action: 'snapshot' }, signal)).resolves.toHaveProperty('targetId', 'owner-target');
      await expect(broker.execute(next, openPublic, signal)).rejects.toMatchObject({ code: 'invalid_action' });
      expect(owner.execute).toHaveBeenCalledOnce();
      expect(publicDriver.execute).toHaveBeenCalledTimes(3);
    } finally { await broker.close(); }
  });

  it('never falls back to the owner driver after the public context fails', async () => {
    const owner = driver('owner-target'), publicDriver = driver('public-target');
    publicDriver.execute.mockRejectedValueOnce(new SharedBrowserError('browser_unavailable'));
    const broker = createSharedBrowserBroker({ ownerId: 'owner', driver: owner, publicDriver, setHumanControl: async () => {} });
    try {
      broker.openRun(binding, signal);
      await expect(broker.execute(binding, openPublic, signal)).rejects.toMatchObject({ code: 'browser_unavailable' });
      await expect(broker.execute(binding, { action: 'snapshot' }, signal)).rejects.toMatchObject({ code: 'browser_changed' });
      expect(publicDriver.execute).toHaveBeenCalledOnce();
      expect(owner.execute).not.toHaveBeenCalled();
    } finally { await broker.close(); }
  });

  it('does not touch the owner driver or input gate when public mode is unavailable', async () => {
    const owner = driver('owner-target');
    const setHumanControl = vi.fn(async () => {});
    const broker = createSharedBrowserBroker({ ownerId: 'owner', driver: owner, setHumanControl });
    try {
      broker.openRun(binding, signal);
      await expect(broker.execute(binding, openPublic, signal)).rejects.toMatchObject({ code: 'browser_unavailable' });
      expect(owner.execute).not.toHaveBeenCalled();
      expect(setHumanControl).not.toHaveBeenCalled();
    } finally { await broker.close(); }
  });
});
