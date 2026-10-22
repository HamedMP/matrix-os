import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanonicalProviderCatalogSchema } from '@matrix-os/contracts';
import { CanonicalChatOrchestrator } from '../../packages/gateway/src/chat/orchestrator.js';
import { CanonicalChatProviderRegistry, type CanonicalChatProviderAdapter } from '../../packages/gateway/src/chat/provider-adapter.js';
import { ChatRepository } from '../../packages/gateway/src/chat/repository.js';
import { createAuthorityFixture } from './google-data/fixture-db.js';

const owner = { type: 'personal' as const, ownerId: 'owner_history' };
const principal = { userId: owner.ownerId, source: 'jwt' as const };
const selection = { instanceId: 'codex_default', model: 'gpt-5.6-sol' };
const catalog = CanonicalProviderCatalogSchema.parse({ revision: 'history_catalog',
  drivers: [{ kind: 'codex', displayName: 'Codex', adapterVersion: '1.0.0', capabilityClass: 'coding_agent' }],
  instances: [{ id: selection.instanceId, driverKind: 'codex', displayName: 'Codex', availability: 'available',
    workspaceRequirement: 'project_optional', catalogRevision: 'history_catalog', models: [{ id: selection.model,
      displayName: 'Model', availability: 'available', capabilities: ['reasoning', 'tools'], supportsVision: false, supportsToolUse: true }],
    options: [], skills: [], commands: [], setupActions: [], supports: { rootChat: true, resume: true, cancellation: true,
      steering: 'same_run', attachments: [], tools: [], approvals: true, userInput: true, worktrees: 'optional', resources: [],
      interactionModes: ['default'], permissionModes: ['supervised'] } }] });
let repository: ChatRepository;
let orchestrator: CanonicalChatOrchestrator | undefined;
beforeEach(async () => {
  const { db } = await createAuthorityFixture(); repository = new ChatRepository(db.sql); await repository.bootstrap();
  await repository.create(owner, { id: 'chat_one', clientRequestId: 'req_create', title: 'one' });
});
afterEach(async () => { await orchestrator?.drain(); orchestrator = undefined; });
function input(requestId: string, revision = 0) { return { clientRequestId: requestId, baseRevision: revision,
  selection, interactionMode: 'default', permissionMode: 'supervised', parts: [{ type: 'text' as const, text: 'Hello' }] }; }
function fixture(start?: CanonicalChatProviderAdapter['start']) {
  let denied = false;
  const starts = vi.fn();
  const adapter: CanonicalChatProviderAdapter = { driverKind: 'codex', stateSchemaVersion: 1,
    parseState: value => value, serializeState: value => value,
    start: start ?? (async function* () { starts(); yield { type: 'run.completed', outcome: 'completed' }; }) };
  const assertRun = vi.fn(async operation => { expect(operation.adapter).toBe(adapter); if (denied) throw new Error('Chat context unavailable'); });
  const read = vi.fn(async operation => { if (denied) throw new Error('Chat context unavailable'); return operation.read(repository); });
  orchestrator = new CanonicalChatOrchestrator({ repository, catalog: { getCatalog: async () => catalog },
    adapters: new CanonicalChatProviderRegistry([adapter]), modelHistory: { read, assertRun } });
  return { adapter, assertRun, read, starts, deny: () => { denied = true; } };
}
describe('history admission through canonical dispatch', () => {
  it('rejects before persisting a fresh turn when the actual selected adapter is not admitted', async () => {
    const f = fixture(); f.deny();
    await expect(orchestrator!.admitTurn(principal, owner, 'chat_one', input('req_denied'))).rejects.toThrow();
    expect(f.assertRun).toHaveBeenCalledOnce(); expect(f.starts).not.toHaveBeenCalled();
    expect((await repository.exportChat(owner, 'chat_one'))!.messages).toHaveLength(0);
  });
  it('checks again after durable run preparation and before invoking the adapter', async () => {
    const f = fixture();
    const running = repository.markRunRunning.bind(repository);
    vi.spyOn(repository, 'markRunRunning').mockImplementation(async (...args) => { await running(...args); f.deny(); });
    await orchestrator!.admitTurn(principal, owner, 'chat_one', input('req_late'));
    await orchestrator!.drain();
    expect(f.assertRun.mock.calls.length).toBeGreaterThanOrEqual(2); expect(f.starts).not.toHaveBeenCalled();
    expect((await repository.exportChat(owner, 'chat_one'))!.runs[0]!.status).toBe('failed');
  });
  it('passes the real adapter to both history preparation and the final dispatch gate', async () => {
    const f = fixture();
    await orchestrator!.admitTurn(principal, owner, 'chat_one', input('req_allowed')); await orchestrator!.drain();
    expect(f.starts).toHaveBeenCalledOnce(); expect(f.assertRun.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(f.read.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [operation] of f.read.mock.calls) expect(operation.adapter).toBe(f.adapter);
  });
  it('rechecks a retry before copying its stored context into another run', async () => {
    const f = fixture();
    const first = await orchestrator!.admitTurn(principal, owner, 'chat_one', input('req_first')); await orchestrator!.drain();
    f.assertRun.mockClear(); f.deny();
    await expect(orchestrator!.retryTurn(principal, owner, 'chat_one', first.turn.id,
      { clientRequestId: 'req_retry', baseRevision: (await repository.get(owner, 'chat_one'))!.chat.revision })).rejects.toThrow();
    expect(f.assertRun).toHaveBeenCalledOnce(); expect((await repository.exportChat(owner, 'chat_one'))!.runs).toHaveLength(1);
  });
  it('rechecks a queued turn after its wait and never starts a newly disallowed run', async () => {
    let release!: () => void; const paused = new Promise<void>(resolve => { release = resolve; }); let started = 0;
    const f = fixture(async function* () { started++; if (started === 1) { yield { type: 'assistant.delta', delta: 'working' }; await paused; }
      yield { type: 'run.completed', outcome: 'completed' }; });
    try {
      await orchestrator!.admitTurn(principal, owner, 'chat_one', input('req_active'));
      await vi.waitFor(() => expect(started).toBe(1));
      await orchestrator!.enqueueQueuedTurn(principal, owner, 'chat_one', input('req_queued', (await repository.get(owner, 'chat_one'))!.chat.revision));
      f.deny(); release();
      await vi.waitFor(async () => expect((await repository.exportChat(owner, 'chat_one'))!.runs).toHaveLength(2));
      await orchestrator!.drain();
      expect(started).toBe(1); expect((await repository.exportChat(owner, 'chat_one'))!.runs.at(-1)!.status).toBe('failed');
    } finally { release(); }
  });
});
