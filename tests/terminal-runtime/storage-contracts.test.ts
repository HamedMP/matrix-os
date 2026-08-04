import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DescriptorSchema,
  NameIndexSchema,
  OperationRecordSchema,
  ReceiptSchema,
} from '../../packages/terminal-runtime/src/contracts.js';
import {
  createRuntimeState,
  type RuntimeState,
} from '../../packages/terminal-runtime/src/runtime-state.js';
import { SecureDirectory } from '../../packages/terminal-runtime/src/storage.js';
import {
  reconcileLifecycle,
  type RuntimeEvidence,
} from '../../packages/terminal-runtime/src/reconciliation.js';
const RUNTIME_ID = '0123456789abcdef0123456789abcdef';
const OTHER_RUNTIME_ID = '11111111111111111111111111111111';
const OPERATION_ID = 'fedcba9876543210fedcba9876543210';
const NOW = '2026-07-26T00:00:00.000Z';
function receipt() {
  return {
    schemaVersion: 1 as const,
    runtimeId: RUNTIME_ID,
    displayName: 'primary',
    cwd: { kind: 'home-relative' as const, path: 'projects/matrix' },
    createdAt: NOW,
    metadataRevision: 1,
    lastKnown: { state: 'live' as const, at: NOW, bootId: 'boot-id-1' },
    zellij: { sessionName: `matrix-t-${RUNTIME_ID}` },
  };
}
describe('terminal runtime durable state contracts', () => {
  it('strictly validates receipt, name-index, operation, and descriptor schemas', () => {
    expect(ReceiptSchema.parse(receipt())).toEqual(receipt());
    expect(
      NameIndexSchema.parse({
        schemaVersion: 1,
        canonical: { primary: { runtimeId: RUNTIME_ID, metadataRevision: 1 } },
        aliases: {},
      }),
    ).toBeTruthy();
    expect(
      OperationRecordSchema.parse({
        schemaVersion: 1,
        operationId: OPERATION_ID,
        runtimeId: RUNTIME_ID,
        generation: 1,
        intent: 'create',
        status: 'accepted',
        requestHash: 'a'.repeat(64),
        committedAt: NOW,
      }),
    ).toBeTruthy();
    expect(
      DescriptorSchema.parse({
        schemaVersion: 1,
        runtimeId: RUNTIME_ID,
        operationId: OPERATION_ID,
        intent: 'create',
        cwd: { kind: 'home-relative', path: 'projects/matrix' },
        launch: { kind: 'agent', configurationRef: OPERATION_ID },
        createdAt: NOW,
      }),
    ).toBeTruthy();
    expect(ReceiptSchema.safeParse({ ...receipt(), command: 'bash' }).success).toBe(false);
    expect(
      ReceiptSchema.safeParse({
        ...receipt(),
        cwd: { kind: 'home-relative', path: '/etc' },
      }).success,
    ).toBe(false);
    expect(
      DescriptorSchema.safeParse({
        schemaVersion: 2,
        runtimeId: RUNTIME_ID,
        operationId: OPERATION_ID,
        intent: 'create',
        cwd: { kind: 'home-relative', path: '..' },
        launch: { kind: 'shell' },
        createdAt: NOW,
      }).success,
    ).toBe(false);
  });
  it('persists receipts exclusively and reports future schemas without guessing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matrix-terminal-state-'));
    let state: RuntimeState | undefined;
    try {
      state = await createRuntimeState({
        durableRoot: join(root, 'durable'),
        runtimeRoot: join(root, 'run'),
      });
      await state.receipts.create(receipt());
      await expect(state.receipts.create(receipt())).rejects.toThrow('state_conflict');
      await expect(state.receipts.read(RUNTIME_ID)).resolves.toEqual({
        kind: 'supported',
        receipt: receipt(),
      });
      const receipts = await SecureDirectory.open(join(root, 'durable', 'receipts'));
      try {
        await receipts.replaceJson(`${RUNTIME_ID}.json`, {
          schemaVersion: 99,
          runtimeId: RUNTIME_ID,
        });
      } finally {
        await receipts.close();
      }
      await expect(state.receipts.read(RUNTIME_ID)).resolves.toEqual({
        kind: 'unsupported',
        schemaVersion: 99,
      });
    } finally {
      await state?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('keeps canonical names and aliases globally unique with revision checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matrix-terminal-names-'));
    let state: RuntimeState | undefined;
    try {
      state = await createRuntimeState({
        durableRoot: join(root, 'durable'),
        runtimeRoot: join(root, 'run'),
      });
      await state.names.register('primary', RUNTIME_ID, 1, Date.parse(NOW));
      await expect(state.names.resolve('primary', Date.parse(NOW))).resolves.toEqual({
        runtimeId: RUNTIME_ID,
        metadataRevision: 1,
        source: 'canonical',
      });
      await state.names.rename({
        runtimeId: RUNTIME_ID,
        to: 'renamed',
        baseRevision: 1,
        nowMs: Date.parse(NOW),
      });
      await expect(state.names.resolve('renamed', Date.parse(NOW))).resolves.toMatchObject({
        runtimeId: RUNTIME_ID,
        metadataRevision: 2,
        source: 'canonical',
      });
      await expect(state.names.resolve('primary', Date.parse(NOW))).resolves.toMatchObject({
        runtimeId: RUNTIME_ID,
        source: 'alias',
      });
      await expect(
        state.names.rename({
          runtimeId: RUNTIME_ID,
          to: 'next',
          baseRevision: 1,
          nowMs: Date.parse(NOW),
        }),
      ).rejects.toThrow('state_conflict');
      await expect(state.names.rename({
        runtimeId: RUNTIME_ID, to: 'renamed',
        baseRevision: 2, nowMs: Date.parse(NOW),
      })).resolves.toBe(2);
      await expect(state.names.register(
        'primary', OTHER_RUNTIME_ID, 1, Date.parse(NOW) + 24 * 60 * 60 * 1000 + 1,
      )).resolves.toBeUndefined();
    } finally {
      await state?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('makes operation retries crash-safe and rejects semantic ID reuse', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matrix-terminal-operations-'));
    const record = {
      schemaVersion: 1 as const,
      operationId: OPERATION_ID,
      runtimeId: RUNTIME_ID,
      generation: 1,
      intent: 'recover' as const,
      status: 'accepted' as const,
      requestHash: 'a'.repeat(64),
      committedAt: NOW,
    };
    let state: RuntimeState | undefined;
    try {
      state = await createRuntimeState({
        durableRoot: join(root, 'durable'),
        runtimeRoot: join(root, 'run'),
      });
      await expect(state.operations.commit(record)).resolves.toEqual(record);
      await expect(state.operations.commit(record)).resolves.toEqual(record);
      await expect(
        state.operations.commit({ ...record, requestHash: 'b'.repeat(64) }),
      ).rejects.toThrow('operation_id_conflict');
      const completed = {
        ...record,
        status: 'ready' as const,
        result: { ok: true, value: { lifecycleState: 'recovering' } },
      };
      await expect(state.operations.complete(completed)).resolves.toEqual(completed);
      await expect(state.operations.complete(completed)).resolves.toEqual(completed);
      await expect(
        state.operations.complete({
          ...completed,
          result: { ok: true, value: { lifecycleState: 'different' } },
        }),
      ).rejects.toThrow('operation_state_conflict');
      await expect(
        state.operations.removeCompleted(OPERATION_ID),
      ).resolves.toBeUndefined();
      await expect(state.operations.read(OPERATION_ID)).resolves.toBeNull();
    } finally {
      await state?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('applies lifecycle evidence precedence without treating receipts as live', () => {
    const base: RuntimeEvidence = {
      deleteIntent: false,
      unit: 'inactive',
      cgroupPopulated: false,
      keeperReady: false,
      keeperAlive: false,
      zellijResponsive: false,
      requiredProcessesInCgroup: false,
      descriptor: null,
      receipt: 'valid',
      resurrection: 'valid',
      priorState: 'live',
      bootIdMatches: false,
    };
    expect(reconcileLifecycle(base)).toMatchObject({
      lifecycleState: 'interrupted',
      recoverable: true,
      recoveryMode: 'serialized',
    });
    expect(reconcileLifecycle({ ...base, deleteIntent: true })).toMatchObject({
      lifecycleState: 'deleting',
      recoverable: false,
    });
    expect(
      reconcileLifecycle({
        ...base,
        unit: 'active',
        cgroupPopulated: true,
        keeperReady: true,
        keeperAlive: true,
        zellijResponsive: true,
        requiredProcessesInCgroup: true,
      }),
    ).toMatchObject({ lifecycleState: 'live', recoverable: false });
    expect(
      reconcileLifecycle({
        ...base,
        receipt: 'unsupported',
        resurrection: 'missing',
        unit: 'active',
        cgroupPopulated: true,
        keeperReady: true,
        keeperAlive: true,
        zellijResponsive: true,
        requiredProcessesInCgroup: true,
      }),
    ).toMatchObject({
      lifecycleState: 'failed',
      recoveryReason: 'unsupported_state',
    });
    expect(reconcileLifecycle({
      ...base, bootIdMatches: true, priorState: 'recovering',
    })).toMatchObject({ lifecycleState: 'interrupted', recoverable: true });
    expect(reconcileLifecycle({
      ...base, bootIdMatches: true, priorState: 'failed',
    })).toMatchObject({ lifecycleState: 'failed', recoverable: true });
  });
});
