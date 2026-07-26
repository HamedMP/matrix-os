import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProtocolRequestSchema } from '../../packages/terminal-runtime/src/contracts.js';
import { createOperationHandler, type SystemdExecutor } from '../../packages/terminal-runtime/src/operation-handler.js';
import { createRuntimeState, type RuntimeState } from '../../packages/terminal-runtime/src/runtime-state.js';
const RUNTIME_ID = '0123456789abcdef0123456789abcdef';
const CREATE_OPERATION_ID = '10000000000000000000000000000000';
const RECOVER_OPERATION_ID = '20000000000000000000000000000000';
const NOW = new Date('2026-07-26T00:00:00.000Z');
function executor(): SystemdExecutor {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    inspect: vi.fn(async () => null),
    list: vi.fn(async () => []),
  };
}
function createRequest(operationId = CREATE_OPERATION_ID) {
  return {
    version: 1 as const,
    operation: 'CreateStart' as const,
    operationId,
    input: {
      displayName: 'primary',
      cwd: { kind: 'home-relative' as const, path: 'projects/matrix' },
      launch: { kind: 'shell' as const },
    },
  };
}
describe('terminal runtime operation handler', () => {
  let root: string | undefined;
  let state: RuntimeState | undefined;
  afterEach(async () => {
    await state?.close();
    state = undefined;
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });
  async function setup(
    resolveCwd = async (cwd: { kind: 'home-relative'; path: string }) => cwd,
    artifacts?: {
      inspect(runtimeId: string): Promise<{
        state: 'valid' | 'missing' | 'corrupt' | 'incompatible';
      }>;
      remove(runtimeId: string): Promise<void>;
      prune(input: { protectedRuntimeIds: Set<string> }): Promise<unknown>;
    },
  ) {
    root = await mkdtemp(join(tmpdir(), 'matrix-terminal-handler-'));
    state = await createRuntimeState({
      durableRoot: join(root, 'durable'),
      runtimeRoot: join(root, 'run'),
    });
    const systemd = executor();
    const handle = createOperationHandler({
      state,
      executor: systemd,
      now: () => NOW,
      bootId: async () => 'boot-id-1',
      createId: () => RUNTIME_ID,
      resolveCwd,
      ...(artifacts ? { artifacts } : {}),
    });
    return { handle, systemd };
  }
  it('replays an identical create result without starting a duplicate runtime', async () => {
    const { handle, systemd } = await setup();
    const request = createRequest();
    const first = await handle(request);
    const retry = await handle(request);
    const sameName = await handle(
      createRequest('30000000000000000000000000000000'),
    );
    expect(first).toMatchObject({
      ok: true,
      result: { runtimeId: RUNTIME_ID, lifecycleState: 'starting' },
    });
    expect(retry).toEqual(first);
    expect(sameName).toMatchObject({
      ok: true,
      result: { runtimeId: RUNTIME_ID },
    });
    expect(systemd.start).toHaveBeenCalledTimes(1);
    expect(systemd.start).toHaveBeenCalledWith(RUNTIME_ID);
    const conflict = await handle({
      ...request,
      input: { ...request.input, displayName: 'different' },
    });
    expect(conflict).toMatchObject({
      ok: false,
      error: { code: 'conflict', message: 'Request failed' },
    });
    expect(systemd.start).toHaveBeenCalledTimes(1);
  });
  it('serializes recover retries and starts at most one unit', async () => {
    const { handle, systemd } = await setup();
    await handle(createRequest());
    await state!.descriptors.claim({
      runtimeId: RUNTIME_ID,
      operationId: CREATE_OPERATION_ID,
      pid: 1,
    }).catch(() => undefined);
    await state!.receipts.replace({
      schemaVersion: 1,
      runtimeId: RUNTIME_ID,
      displayName: 'primary',
      cwd: { kind: 'home-relative', path: 'projects/matrix' },
      createdAt: NOW.toISOString(),
      metadataRevision: 1,
      lastKnown: {
        state: 'interrupted',
        at: NOW.toISOString(),
        bootId: 'boot-id-1',
      },
      zellij: { sessionName: `matrix-t-${RUNTIME_ID}` },
    });
    vi.mocked(systemd.start).mockClear();
    const request = {
      version: 1 as const,
      operation: 'Recover' as const,
      operationId: RECOVER_OPERATION_ID,
      input: { runtimeId: RUNTIME_ID },
    };
    const [first, retry] = await Promise.all([handle(request), handle(request)]);
    expect(first).toMatchObject({
      ok: true,
      result: { runtimeId: RUNTIME_ID, lifecycleState: 'recovering' },
    });
    expect(retry).toEqual(first);
    expect(systemd.start).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['valid', 'serialized', null],
    ['missing', 'fresh-shell', 'history_unavailable'],
    ['corrupt', 'fresh-shell', 'history_unavailable'],
    ['incompatible', 'fresh-shell', 'history_unavailable'],
  ] as const)(
    'projects %s resurrection state into explicit recovery mode %s',
    async (artifactState, recoveryMode, recoveryReason) => {
      const artifacts = {
        inspect: vi.fn(async () => ({ state: artifactState })),
        remove: vi.fn(async () => undefined),
        prune: vi.fn(async () => ({ removedRuntimeIds: [] })),
      };
      const { handle } = await setup(undefined, artifacts);
      await handle(createRequest());
      await state!.descriptors.removeRuntime(RUNTIME_ID);
      await state!.receipts.replace({
        schemaVersion: 1,
        runtimeId: RUNTIME_ID,
        displayName: 'primary',
        cwd: { kind: 'home-relative', path: 'projects/matrix' },
        createdAt: NOW.toISOString(),
        metadataRevision: 1,
        lastKnown: {
          state: 'live',
          at: NOW.toISOString(),
          bootId: 'old-boot',
        },
        zellij: { sessionName: `matrix-t-${RUNTIME_ID}` },
      });

      await expect(handle({
        version: 1,
        operation: 'Inspect',
        operationId: '21000000000000000000000000000000',
        input: { runtimeId: RUNTIME_ID },
      })).resolves.toMatchObject({
        ok: true,
        result: {
          lifecycleState: 'interrupted',
          recoverable: true,
          recoveryMode,
          recoveryReason,
        },
      });
    },
  );
  it('lists receipt-only runtimes and assigns unique ordered operation generations', async () => {
    const { handle, systemd } = await setup();
    await handle(createRequest());
    const listed = await handle({
      version: 1,
      operation: 'List',
      operationId: '40000000000000000000000000000000',
      input: {},
    });
    expect(listed).toMatchObject({
      ok: true,
      result: [{ runtimeId: RUNTIME_ID, displayName: 'primary' }],
    });
    vi.mocked(systemd.list).mockResolvedValueOnce(Array.from({ length: 2_049 }, (_, index) => ({
      runtimeId: index.toString(16).padStart(32, '0'), unit: 'inactive', cgroupPopulated: false,
      keeperReady: false, keeperAlive: false, zellijResponsive: false,
      requiredProcessesInCgroup: false, resurrection: 'missing',
    })));
    await expect(handle({
      version: 1, operation: 'List',
      operationId: '41000000000000000000000000000000', input: {},
    })).resolves.toMatchObject({ ok: false, error: { code: 'failed' } });
    const operationIds = Array.from(
      { length: 8 },
      (_, index) => `${(index + 5).toString(16)}${'0'.repeat(31)}`,
    );
    await Promise.all(
      operationIds.map((operationId) =>
        handle({
          version: 1,
          operation: 'Reconcile',
          operationId,
          input: {},
        }),
      ),
    );
    const generations = await Promise.all(
      operationIds.map(async (operationId) => {
        const record = await state!.operations.read(operationId);
        return record?.generation;
      }),
    );
    expect(new Set(generations).size).toBe(generations.length);
  });
  it('records one failed create and removes its launch descriptor', async () => {
    const { handle, systemd } = await setup();
    vi.mocked(systemd.start).mockRejectedValueOnce(new Error('systemd_failed'));
    const response = await handle(createRequest());
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'failed', message: 'Request failed' },
    });
    expect(await state!.receipts.read(RUNTIME_ID)).toMatchObject({
      kind: 'supported',
      receipt: { lastKnown: { state: 'failed' } },
    });
    expect(await state!.descriptors.countPending()).toBe(0);
    const retry = await handle(createRequest());
    expect(retry).toEqual(response);
    const newAttempt = await handle(createRequest(
      '50000000000000000000000000000000',
    ));
    expect(newAttempt).toMatchObject({ ok: false, error: { code: 'failed' } });
    await expect(handle({
      version: 1, operation: 'Recover',
      operationId: '51000000000000000000000000000000',
      input: { runtimeId: RUNTIME_ID },
    })).resolves.toMatchObject({
      ok: true, result: { runtimeId: RUNTIME_ID, lifecycleState: 'recovering' },
    });
    expect(systemd.start).toHaveBeenCalledTimes(2);
  });
  it('repairs an interrupted receipt-to-name publication without a duplicate', async () => {
    const { handle, systemd } = await setup();
    vi.spyOn(state!.names, 'register').mockRejectedValueOnce(new Error('index_write_failed'));
    await expect(handle(createRequest())).resolves.toMatchObject({ ok: false, error: { code: 'failed' } });
    expect(await state!.receipts.read(RUNTIME_ID)).toMatchObject({ kind: 'supported' });
    expect(await state!.names.resolve('primary', NOW.getTime())).toBeNull();
    await expect(handle(createRequest('52000000000000000000000000000000')))
      .resolves.toMatchObject({ ok: true, result: { runtimeId: RUNTIME_ID } });
    expect((await state!.receipts.list())).toHaveLength(1);
    expect(systemd.start).not.toHaveBeenCalled();
    await expect(handle(createRequest())).resolves.toMatchObject({ ok: true,
      result: { runtimeId: RUNTIME_ID, lifecycleState: 'starting' } });
    expect(systemd.start).toHaveBeenCalledTimes(1);
  });
  it('resumes an accepted create against its original runtime', async () => {
    const { handle, systemd } = await setup();
    const request = createRequest();
    await state!.operations.commit({
      schemaVersion: 1, operationId: request.operationId, runtimeId: RUNTIME_ID,
      generation: 1, intent: 'create', status: 'accepted',
      requestHash: createHash('sha256')
        .update(JSON.stringify(ProtocolRequestSchema.parse(request))).digest('hex'),
      committedAt: NOW.toISOString(),
    });
    await state!.receipts.create({
      schemaVersion: 1, runtimeId: RUNTIME_ID, displayName: 'primary',
      cwd: request.input.cwd, createdAt: NOW.toISOString(), metadataRevision: 1,
      lastKnown: { state: 'starting', at: NOW.toISOString(), bootId: 'boot-id-1' },
      zellij: { sessionName: `matrix-t-${RUNTIME_ID}` },
    });
    await state!.names.register('primary', RUNTIME_ID, 1, NOW.getTime());
    await expect(handle(request)).resolves.toMatchObject({
      ok: true, result: { runtimeId: RUNTIME_ID, lifecycleState: 'starting' },
    });
    expect(systemd.start).toHaveBeenCalledWith(RUNTIME_ID);
  });
  it('reconcile completes deletion only after the cgroup is empty', async () => {
    const artifacts = {
      inspect: vi.fn(async () => ({ state: 'missing' as const })),
      remove: vi.fn(async () => undefined),
      prune: vi.fn(async () => ({ removedRuntimeIds: [] })),
    };
    const { handle, systemd } = await setup(undefined, artifacts);
    await handle(createRequest());
    vi.mocked(systemd.inspect).mockResolvedValueOnce({
      runtimeId: RUNTIME_ID, unit: 'inactive', cgroupPopulated: true,
      keeperReady: false, keeperAlive: false, zellijResponsive: false,
      requiredProcessesInCgroup: false, resurrection: 'missing',
    });
    await expect(handle({
      version: 1, operation: 'Delete',
      operationId: '60000000000000000000000000000000',
      input: { runtimeId: RUNTIME_ID },
    })).resolves.toMatchObject({
      ok: true, result: { lifecycleState: 'deleting' },
    });
    expect(artifacts.remove).not.toHaveBeenCalled();
    await handle({
      version: 1, operation: 'Reconcile',
      operationId: '70000000000000000000000000000000', input: {},
    });
    expect(await state!.receipts.read(RUNTIME_ID)).toBeNull();
    expect(await state!.names.resolve('primary', NOW.getTime())).toBeNull();
    expect(artifacts.remove).toHaveBeenCalledWith(RUNTIME_ID);
  });
  it('serializes Delete before Recover and never recreates removed state', async () => {
    let releaseStop = () => undefined;
    const stopGate = new Promise<void>((resolveStop) => {
      releaseStop = resolveStop;
    });
    const artifacts = {
      inspect: vi.fn(async () => ({ state: 'missing' as const })),
      remove: vi.fn(async () => undefined),
      prune: vi.fn(async () => ({ removedRuntimeIds: [] })),
    };
    const { handle, systemd } = await setup(undefined, artifacts);
    await handle(createRequest());
    vi.mocked(systemd.start).mockClear();
    vi.mocked(systemd.stop).mockImplementationOnce(async () => await stopGate);
    const deleting = handle({
      version: 1,
      operation: 'Delete',
      operationId: '61000000000000000000000000000000',
      input: { runtimeId: RUNTIME_ID },
    });
    await vi.waitFor(() => expect(systemd.stop).toHaveBeenCalledTimes(1));
    const recovering = handle({
      version: 1,
      operation: 'Recover',
      operationId: '62000000000000000000000000000000',
      input: { runtimeId: RUNTIME_ID },
    });
    releaseStop();

    await expect(deleting).resolves.toMatchObject({
      ok: true,
      result: { deleted: true },
    });
    await expect(recovering).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(systemd.start).not.toHaveBeenCalled();
  });
  it('fails before launch when cwd cannot be resolved inside the owner home', async () => {
    const { handle, systemd } = await setup(async () => {
      throw new Error('cwd_unavailable');
    });
    await expect(handle(createRequest())).resolves.toMatchObject({
      ok: false, error: { code: 'failed', message: 'Request failed' },
    });
    expect(systemd.start).not.toHaveBeenCalled();
    expect(await state!.receipts.read(RUNTIME_ID)).toBeNull();
  });
});
