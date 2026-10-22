import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedPiRuntimeBinding } from '../../../packages/gateway/src/bots/runtime-registry.js';
import { createGooglePilotArtifactWriteFence } from '../../../packages/gateway/src/google-data/runtime/pilot-artifact-writes.js';
import { createBotToolDispatcher } from '../../../packages/gateway/src/bots/tool-dispatcher.js';

const binding: ManagedPiRuntimeBinding = {
  kind: 'managed_chat', ownerId: 'owner_one', chatId: 'chat_one', runId: 'run_one',
  runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1', workspace: { kind: 'chat_workspace' },
  rootFingerprint: 'a'.repeat(64), capabilities: ['artifact.write', 'artifact.read'], requestClass: 'interactive',
  accessSourceId: 'matrix_included', route: { api: 'anthropic-messages', modelId: 'synthetic', input: ['text'], contextWindow: 1000, maxOutputTokens: 100 },
};
const request = (relPath = 'nested/report.txt') => ({ toolCallId: 'call_one', capability: 'artifact.write' as const,
  args: { relPath, content: 'synthetic mail-derived text', mimeType: 'text/plain' } });
let home: string;
let root: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'matrix-google-artifact-')); root = join(home, 'workspace'); await mkdir(root); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
describe('prospective Google pilot artifact boundary', () => {
  it('refuses before workspace resolution, nested directory creation or any content staging', async () => {
    const managedWorkspace = vi.fn(async () => root);
    const assertAllowed = vi.fn(async () => { throw new Error('Tool unavailable'); });
    const dispatcher = createBotToolDispatcher({ homePath: home, managedWorkspace, artifactWrites: { assertAllowed } });
    const blocked = request(); const body = vi.fn(() => { throw new Error('Body must not be read'); });
    Object.defineProperty(blocked.args, 'content', { get: body });
    await expect(dispatcher.dispatch(binding, blocked, new AbortController().signal)).rejects.toThrow('Tool unavailable');
    expect(body).not.toHaveBeenCalled();
    expect(assertAllowed).toHaveBeenCalledOnce(); expect(managedWorkspace).not.toHaveBeenCalled();
    expect(await readdir(home)).toEqual(['workspace']); expect(await readdir(root)).toEqual([]);
  });
  it('always refuses admitted pilot runs before and after Google collection, including stale/cancelled bindings', async () => {
    const lifetime = new AbortController(); const registry = { lookupRun: vi.fn(() => binding), inferenceSignal: vi.fn(() => lifetime.signal) };
    const fence = createGooglePilotArtifactWriteFence(registry);
    const dispatcher = createBotToolDispatcher({ homePath: home, managedWorkspace: async () => root, artifactWrites: fence });
    await expect(dispatcher.dispatch(binding, request(), lifetime.signal)).rejects.toMatchObject({ code: 'not_granted' });
    registry.lookupRun.mockReturnValueOnce({ ...binding, executionGeneration: '2' });
    await expect(dispatcher.dispatch(binding, request(), lifetime.signal)).rejects.toMatchObject({ code: 'not_granted' });
    lifetime.abort();
    await expect(dispatcher.dispatch(binding, request(), lifetime.signal)).rejects.toMatchObject({ code: 'not_granted' });
    expect(await readdir(home)).toEqual(['workspace']); expect(await readdir(root)).toEqual([]);
  });
  it('keeps uninstalled ordinary file generation unchanged', async () => {
    await createBotToolDispatcher({ homePath: home, managedWorkspace: async () => root })
      .dispatch(binding, request(), new AbortController().signal);
    expect(await readFile(join(root, 'nested/report.txt'), 'utf8')).toBe(request().args.content);
  });
  it('rechecks an initially permitted source immediately before publication and removes its staging copy on refusal', async () => {
    const assertAllowed = vi.fn(async () => undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Tool unavailable'));
    const dispatcher = createBotToolDispatcher({ homePath: home, managedWorkspace: async () => root, artifactWrites: { assertAllowed } });
    await expect(dispatcher.dispatch(binding, request('report.txt'), new AbortController().signal)).rejects.toThrow('Tool unavailable');
    expect(assertAllowed).toHaveBeenCalledTimes(2); expect(await readdir(root)).toEqual([]);
    for (const directory of (await readdir(home)).filter(name => name !== 'workspace')) expect(await readdir(join(home, directory))).toEqual([]);
  });
});
