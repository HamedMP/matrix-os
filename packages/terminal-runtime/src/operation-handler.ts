import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  ProtocolRequestSchema, RuntimeIdSchema, createRuntimeId, type Descriptor,
  type HomeRelativeCwd, type OperationRecord, type ProtocolRequest,
  type ProtocolResponse, type Receipt,
} from './contracts.js';
import { reconcileLifecycle, type RuntimeEvidence } from './reconciliation.js';
import type { ReceiptReadResult } from './receipts.js';
import type { RuntimeState } from './runtime-state.js';
import type { RuntimeArtifactManager } from './recovery-state.js';
const MAX_LIST_RUNTIMES = 2_048;
const INACTIVE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_INACTIVE_RECOVERY_SETS = 128;
const RECOVERY_AGGREGATE_TARGET_BYTES = 1024 * 1024 * 1024;
const RECOVERY_RUNTIME_TARGET_BYTES = 64 * 1024 * 1024;
export type UnitInspection = {
  runtimeId: string; cgroupPopulated: boolean; keeperReady: boolean;
  keeperAlive: boolean; zellijResponsive: boolean;
  unit: 'active' | 'activating' | 'inactive' | 'failed' | 'missing';
  requiredProcessesInCgroup: boolean;
  resurrection: 'valid' | 'missing' | 'corrupt' | 'incompatible';
};
export interface SystemdExecutor {
  start(runtimeId: string): Promise<void>; stop(runtimeId: string): Promise<void>;
  inspect(runtimeId: string): Promise<UnitInspection | null>; list(): Promise<UnitInspection[]>;
}
type OperationHandlerOptions = {
  state: RuntimeState; executor: SystemdExecutor; now?: () => Date;
  bootId?: () => Promise<string>; createId?: () => string;
  resolveCwd: (cwd: HomeRelativeCwd) => Promise<HomeRelativeCwd>;
  artifacts?: RuntimeArtifactManager;
};
type ProtocolErrorCode = 'invalid_request' | 'not_found' | 'conflict'
  | 'unavailable' | 'failed';
type StoredOutcome = { ok: true; value: unknown }
  | { ok: false; code: ProtocolErrorCode };
class OperationFailure extends Error {
  constructor(readonly code: ProtocolErrorCode, cause?: unknown) {
    super('operation_failed', cause === undefined ? undefined : { cause });
  }
}
function requestHash(request: ProtocolRequest): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}
function errorResponse(operationId: string | undefined, code: ProtocolErrorCode): ProtocolResponse {
  return {
    version: 1,
    ok: false,
    ...(operationId ? { operationId } : {}),
    error: { code, message: 'Request failed' },
  };
}
function mapError(error: unknown): ProtocolErrorCode {
  if (error instanceof OperationFailure) return error.code;
  if (!(error instanceof Error)) return 'failed';
  if (['state_conflict', 'name_conflict', 'operation_id_conflict',
    'descriptor_capacity'].includes(error.message)) return 'conflict';
  if (['state_not_found', 'descriptor_not_found'].includes(error.message))
    return 'not_found';
  if (error.message.startsWith('lock_')) return 'unavailable';
  return 'failed';
}
function parseStoredOutcome(value: unknown): StoredOutcome | null {
  if (typeof value !== 'object' || value === null || !('ok' in value)) return null;
  if (value.ok === true && 'value' in value) {
    return { ok: true, value: value.value };
  }
  if (value.ok === false && 'code' in value && typeof value.code === 'string' &&
    ['invalid_request', 'not_found', 'conflict', 'unavailable', 'failed']
      .includes(value.code)) {
    return { ok: false, code: value.code as ProtocolErrorCode };
  }
  return null;
}
function unwrapOutcome(outcome: StoredOutcome): unknown {
  if (outcome.ok) return outcome.value;
  throw new OperationFailure(outcome.code);
}
async function defaultBootId(): Promise<string> {
  const value = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new Error('boot_id_invalid');
  return value;
}
function evidenceFor(receipt: ReceiptReadResult, inspection: UnitInspection | null,
  descriptor: RuntimeEvidence['descriptor'], bootIdMatches: boolean,
  resurrection?: UnitInspection['resurrection']): RuntimeEvidence {
  return {
    deleteIntent: receipt?.kind === 'supported' &&
      receipt.receipt.lastKnown.state === 'deleting',
    unit: inspection?.unit ?? 'missing',
    cgroupPopulated: inspection?.cgroupPopulated ?? false,
    keeperReady: inspection?.keeperReady ?? false, keeperAlive: inspection?.keeperAlive ?? false,
    zellijResponsive: inspection?.zellijResponsive ?? false,
    requiredProcessesInCgroup: inspection?.requiredProcessesInCgroup ?? false,
    descriptor,
    receipt: receipt === null ? 'missing'
      : receipt.kind === 'unsupported' ? 'unsupported' : 'valid',
    resurrection: resurrection ?? inspection?.resurrection ?? 'missing',
    priorState: receipt?.kind === 'supported' ? receipt.receipt.lastKnown.state : null,
    bootIdMatches,
  };
}
export function createOperationHandler(options: OperationHandlerOptions) {
  const now = options.now ?? (() => new Date());
  const bootId = options.bootId ?? defaultBootId;
  const createId = options.createId ?? createRuntimeId;
  async function inspectRuntime(runtimeId: string) {
    const id = RuntimeIdSchema.parse(runtimeId);
    const [receipt, inspection, descriptor, currentBootId, artifact] = await Promise.all([
      options.state.receipts.read(id), options.executor.inspect(id),
      options.state.descriptors.pendingKind(id), bootId(),
      options.artifacts?.inspect(id),
    ]);
    return {
      runtimeId: id,
      ...(receipt?.kind === 'supported'
        ? {
            displayName: receipt.receipt.displayName,
            metadataRevision: receipt.receipt.metadataRevision,
          }
        : {}),
      ...reconcileLifecycle(evidenceFor(receipt, inspection, descriptor,
        receipt?.kind !== 'supported' ||
          receipt.receipt.lastKnown.bootId === currentBootId,
        artifact?.state)),
    };
  }
  async function listRuntimes() {
    const [units, receipts] = await Promise.all([
      options.executor.list(), options.state.receipts.list(),
    ]);
    const runtimeIds = new Set<string>();
    const addRuntimeId = (runtimeId: string) => {
      const id = RuntimeIdSchema.parse(runtimeId);
      if (!runtimeIds.has(id) && runtimeIds.size >= MAX_LIST_RUNTIMES) {
        throw new Error('runtime_list_capacity');
      }
      runtimeIds.add(id);
    };
    for (const unit of units) addRuntimeId(unit.runtimeId);
    for (const receipt of receipts) addRuntimeId(receipt.runtimeId);
    return await Promise.all([...runtimeIds].sort().map(inspectRuntime));
  }
  async function beginOperation(request: ProtocolRequest,
    intent: OperationRecord['intent'], runtimeId: string | null,
  ): Promise<{ record: OperationRecord; replay: StoredOutcome | null }> {
    const hash = requestHash(request);
    const current = await options.state.operations.read(request.operationId);
    if (current) {
      if (current.requestHash !== hash) throw new Error('operation_id_conflict');
      if (current.intent !== intent || current.runtimeId !== runtimeId) {
        throw new Error('operation_state_conflict');
      }
      return { record: current, replay: parseStoredOutcome(current.result) };
    }
    const record = await options.state.operations.commit({
      schemaVersion: 1, operationId: request.operationId, runtimeId,
      generation: await options.state.operations.nextGeneration(),
      intent, status: 'accepted', requestHash: hash, committedAt: now().toISOString(),
    });
    return { record, replay: parseStoredOutcome(record.result) };
  }
  async function finishOperation(record: OperationRecord,
    outcome: StoredOutcome): Promise<void> {
    await options.state.operations.complete({
      ...record, status: outcome.ok ? 'ready' : 'failed', result: outcome,
    });
  }
  async function succeedOperation(record: OperationRecord,
    value: unknown): Promise<unknown> {
    await finishOperation(record, { ok: true, value });
    return value;
  }
  async function failOperation(record: OperationRecord, error: unknown): Promise<never> {
    const code = mapError(error);
    await finishOperation(record, { ok: false, code });
    throw new OperationFailure(code, error);
  }
  async function mutate(request: ProtocolRequest, intent: OperationRecord['intent'],
    runtimeId: string | null,
    callback: (record: OperationRecord, resuming: boolean) => Promise<unknown>,
  ): Promise<unknown> {
    return await options.state.locks.withNameIndex(async () => {
      const existing = await options.state.operations.read(request.operationId);
      if (existing && existing.requestHash !== requestHash(request)) {
        throw new Error('operation_id_conflict');
      }
      const target = existing?.runtimeId ?? runtimeId;
      const run = async () => {
        const operation = await beginOperation(request, intent, target);
        return operation.replay
          ? unwrapOutcome(operation.replay)
          : callback(operation.record, existing !== null);
      };
      return target === null
        ? run()
        : options.state.locks.withRuntime(target, false, run);
    });
  }
  async function markReceiptFailed(runtimeId: string): Promise<void> {
    const current = await options.state.receipts.read(runtimeId);
    if (current?.kind !== 'supported') return;
    await options.state.receipts.replace({
      ...current.receipt,
      lastKnown: { ...current.receipt.lastKnown, state: 'failed',
        at: now().toISOString() },
    });
  }
  async function failStart(record: OperationRecord, runtimeId: string,
    operationId: string, error: unknown): Promise<never> {
    await options.state.descriptors.remove(runtimeId, operationId);
    await markReceiptFailed(runtimeId);
    return await failOperation(record, error);
  }
  async function createStart(request: Extract<ProtocolRequest,
    { operation: 'CreateStart' }>) {
    const proposedId = RuntimeIdSchema.parse(createId());
    return await mutate(request, 'create', proposedId, async (record, resuming) => {
      const runtimeId = RuntimeIdSchema.parse(record.runtimeId);
      let existingName = await options.state.names.resolve(request.input.displayName, now().getTime());
      if (!existingName) {
        const orphan = await options.state.receipts.findByDisplayName(request.input.displayName);
        if (orphan) {
          await options.state.names.register(request.input.displayName, orphan.runtimeId, orphan.metadataRevision, now().getTime());
          existingName = { runtimeId: orphan.runtimeId, source: 'canonical' };
        }
      }
      if (existingName && (!resuming || existingName.runtimeId !== runtimeId)) {
        const result = await inspectRuntime(existingName.runtimeId);
        // Failed identities stay reserved; only explicit Recover may restart them.
        if (result.lifecycleState === 'failed')
          return await failOperation(record, new Error('runtime_failed'));
        return await succeedOperation(record, result);
      }
      const stored = await options.state.receipts.read(runtimeId);
      if (stored?.kind === 'unsupported')
        return await failOperation(record, new Error('state_conflict'));
      if (stored?.kind === 'supported' &&
        stored.receipt.lastKnown.state === 'failed')
        return await failOperation(record, new Error('runtime_failed'));
      if (stored?.kind === 'supported' &&
        stored.receipt.displayName !== request.input.displayName)
        return await failOperation(record, new Error('state_conflict'));
      let cwd: HomeRelativeCwd;
      if (stored?.kind === 'supported') {
        cwd = stored.receipt.cwd;
      } else {
        try {
          cwd = await options.resolveCwd(request.input.cwd ?? {
            kind: 'home-relative', path: '',
          });
        } catch (error: unknown) {
          return await failOperation(record, error);
        }
        const createdAt = now().toISOString();
        await options.state.receipts.create({
          schemaVersion: 1, runtimeId, displayName: request.input.displayName,
          cwd, createdAt, metadataRevision: 1,
          lastKnown: { state: 'starting', at: createdAt, bootId: await bootId() },
          zellij: { sessionName: `matrix-t-${runtimeId}` },
        });
      }
      if (!existingName) await options.state.names.register(
        request.input.displayName, runtimeId, 1, now().getTime());
      const inspection = await options.executor.inspect(runtimeId);
      if (inspection?.unit === 'active' || inspection?.unit === 'activating') {
        return await succeedOperation(record, await inspectRuntime(runtimeId));
      }
      const createdAt = now().toISOString();
      const descriptor: Descriptor = {
        schemaVersion: 1, runtimeId, operationId: request.operationId,
        intent: 'create', cwd, launch: request.input.launch, createdAt,
      };
      try {
        // Fixed-template systemd start is idempotent and resumes this runtime only.
        await options.state.descriptors.removeRuntime(runtimeId);
        await options.state.descriptors.publish(descriptor);
        await options.executor.start(runtimeId);
      } catch (error: unknown) {
        return await failStart(record, runtimeId, request.operationId, error);
      }
      return await succeedOperation(record,
        { runtimeId, lifecycleState: 'starting' });
    });
  }
  async function recover(request: Extract<ProtocolRequest, { operation: 'Recover' }>) {
    return await mutate(
      request,
      'recover',
      request.input.runtimeId,
      async (record) => {
        const current = await options.state.receipts.read(request.input.runtimeId);
        if (!current || current.kind !== 'supported') {
          return await failOperation(record, new Error('state_not_found'));
        }
        if (current.receipt.lastKnown.state === 'deleting') {
          return await failOperation(record, new Error('state_conflict'));
        }
        const inspection = await options.executor.inspect(current.receipt.runtimeId);
        if (inspection?.unit === 'active' || inspection?.unit === 'activating') {
          const result = await inspectRuntime(current.receipt.runtimeId);
          return await succeedOperation(record, result);
        }
        let cwd: HomeRelativeCwd;
        let cwdFallback = false;
        try {
          cwd = await options.resolveCwd(current.receipt.cwd);
        } catch (error: unknown) {
          try {
            cwd = await options.resolveCwd({ kind: 'home-relative', path: '' });
            cwdFallback = true;
          } catch (fallbackError: unknown) {
            return await failOperation(record,
              new AggregateError([error, fallbackError], 'cwd_unavailable'));
          }
        }
        const resurrection = await options.artifacts?.inspect(
          current.receipt.runtimeId,
        );
        const recoveryMode = resurrection?.state === 'valid'
          ? 'serialized'
          : 'fresh-shell';
        if (options.artifacts && recoveryMode === 'fresh-shell') {
          await options.artifacts.prepareFreshRecovery(
            current.receipt.runtimeId,
          );
        }
        const descriptor: Descriptor = {
          schemaVersion: 1, runtimeId: current.receipt.runtimeId,
          operationId: request.operationId, intent: 'recover', cwd,
          recoveryMode,
          launch: { kind: 'shell' }, createdAt: now().toISOString(),
        };
        try {
          await options.state.descriptors.removeRuntime(current.receipt.runtimeId);
          await options.state.descriptors.publish(descriptor);
          await options.state.receipts.replace({
            ...current.receipt,
            cwd,
            lastKnown: { state: 'recovering', at: now().toISOString(),
              bootId: await bootId() },
          });
          await options.executor.start(current.receipt.runtimeId);
        } catch (error: unknown) {
          return await failStart(record, current.receipt.runtimeId,
            request.operationId, error);
        }
        return await succeedOperation(record, {
          runtimeId: current.receipt.runtimeId,
          lifecycleState: 'recovering',
          recoveryMode,
          recoveryReason: cwdFallback
            ? 'cwd_unavailable'
            : recoveryMode === 'fresh-shell'
              ? 'history_unavailable'
              : null,
        });
      },
    );
  }
  async function renameMetadata(request: Extract<ProtocolRequest,
    { operation: 'RenameMetadata' }>) {
    return await mutate(
      request,
      'rename',
      request.input.runtimeId,
      async (record) => {
        const current = await options.state.receipts.read(request.input.runtimeId);
        if (!current || current.kind !== 'supported') {
          throw new Error('state_not_found');
        }
        const nextRevision = request.input.baseRevision + 1;
        if (
          current.receipt.metadataRevision !== request.input.baseRevision &&
          (current.receipt.metadataRevision !== nextRevision ||
            current.receipt.displayName !== request.input.displayName)
        ) throw new Error('state_conflict');
        const target = await options.state.names.resolve(
          request.input.displayName, now().getTime(),
        );
        if (target && target.runtimeId !== request.input.runtimeId) {
          throw new Error('name_conflict');
        }
        if (current.receipt.metadataRevision === request.input.baseRevision) {
          await options.state.receipts.replace({
            ...current.receipt, displayName: request.input.displayName,
            metadataRevision: nextRevision,
          });
        }
        const revision = await options.state.names.rename({
          runtimeId: request.input.runtimeId,
          to: request.input.displayName,
          baseRevision: request.input.baseRevision,
          nowMs: now().getTime(),
        });
        return await succeedOperation(record, {
          runtimeId: request.input.runtimeId,
          displayName: request.input.displayName,
          metadataRevision: revision,
        });
      },
    );
  }
  async function finishDeletion(runtimeId: string,
    record: OperationRecord | null): Promise<{ runtimeId: string; deleted: true }> {
    await options.artifacts?.remove(runtimeId);
    await options.state.names.deleteRuntime(runtimeId);
    await options.state.descriptors.removeRuntime(runtimeId);
    const result = { runtimeId, deleted: true as const };
    if (record) await finishOperation(record, { ok: true, value: result });
    await options.state.receipts.delete(runtimeId);
    return result;
  }
  async function deleteRuntime(request: Extract<ProtocolRequest,
    { operation: 'Delete' }>) {
    return await mutate(
      request,
      'delete',
      request.input.runtimeId,
      async (record) => {
        const current = await options.state.receipts.read(request.input.runtimeId);
        if (!current) {
          const result = { runtimeId: request.input.runtimeId, deleted: true };
          return await succeedOperation(record, result);
        }
        if (current.kind !== 'supported') {
          return await failOperation(record, new Error('state_conflict'));
        }
        const deleting: Receipt = { ...current.receipt,
          lastKnown: { state: 'deleting', at: now().toISOString(),
            bootId: await bootId() } };
        await options.state.receipts.replace(deleting);
        await options.executor.stop(request.input.runtimeId);
        const inspection = await options.executor.inspect(request.input.runtimeId);
        if (
          inspection?.cgroupPopulated ||
          inspection?.unit === 'active' ||
          inspection?.unit === 'activating'
        ) {
          return { runtimeId: request.input.runtimeId,
            lifecycleState: 'deleting' };
        }
        return await finishDeletion(request.input.runtimeId, record);
      },
    );
  }
  async function reconcile(request: Extract<ProtocolRequest,
    { operation: 'Reconcile' }>) {
    return await mutate(request, 'reconcile', null, async (record) => {
      for (const { runtimeId, state } of await options.state.receipts.list()) {
        if (
          state?.kind !== 'supported' ||
          state.receipt.lastKnown.state !== 'deleting'
        ) continue;
        await options.state.locks.withRuntime(runtimeId, false, async () => {
          let inspection = await options.executor.inspect(runtimeId);
          if (
            inspection?.cgroupPopulated ||
            inspection?.unit === 'active' ||
            inspection?.unit === 'activating'
          ) {
            await options.executor.stop(runtimeId);
            inspection = await options.executor.inspect(runtimeId);
          }
          if (
            inspection?.cgroupPopulated ||
            inspection?.unit === 'active' ||
            inspection?.unit === 'activating'
          ) return;
          const deletion = await options.state.operations.latest(runtimeId, 'delete');
          await finishDeletion(runtimeId, deletion);
        });
      }
      const result = await listRuntimes();
      if (options.artifacts) {
        for (const runtime of result) {
          if (
            ['interrupted', 'exited', 'failed'].includes(
              runtime.lifecycleState,
            )
          ) {
            await options.artifacts.clearAgentState(runtime.runtimeId);
          }
        }
        const protectedRuntimeIds = new Set(
          result.flatMap((runtime) =>
            ['starting', 'live', 'recovering', 'deleting']
              .includes(runtime.lifecycleState)
              ? [runtime.runtimeId]
              : []),
        );
        await options.artifacts.prune({
          protectedRuntimeIds,
          nowMs: now().getTime(),
          retentionMs: INACTIVE_RETENTION_MS,
          maxInactiveSets: MAX_INACTIVE_RECOVERY_SETS,
          aggregateTargetBytes: RECOVERY_AGGREGATE_TARGET_BYTES,
          perRuntimeTargetBytes: RECOVERY_RUNTIME_TARGET_BYTES,
        });
      }
      // The supervisor invokes Reconcile at startup and on its recurring sweep.
      return await succeedOperation(record, result);
    });
  }
  return async (rawRequest: unknown): Promise<ProtocolResponse> => {
    const parsed = ProtocolRequestSchema.safeParse(rawRequest);
    if (!parsed.success) return errorResponse(undefined, 'invalid_request');
    const request = parsed.data;
    try {
      let result: unknown;
      switch (request.operation) {
        case 'CreateStart': result = await createStart(request); break;
        case 'Inspect': result = await inspectRuntime(request.input.runtimeId); break;
        case 'List': result = await listRuntimes(); break;
        case 'Recover': result = await recover(request); break;
        case 'RenameMetadata': result = await renameMetadata(request); break;
        case 'Delete': result = await deleteRuntime(request); break;
        case 'Reconcile': result = await reconcile(request); break;
      }
      return { version: 1, ok: true, operationId: request.operationId, result };
    } catch (error: unknown) {
      return errorResponse(request.operationId, mapError(error));
    }
  };
}
