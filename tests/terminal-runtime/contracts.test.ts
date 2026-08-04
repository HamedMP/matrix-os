import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  OperationIdSchema,
  ProtocolRequestSchema,
  RuntimeIdSchema,
  unitNameForRuntimeId,
} from '../../packages/terminal-runtime/src/contracts.js';
import {
  MAX_FRAME_BYTES,
  decodeFrame,
  encodeFrame,
} from '../../packages/terminal-runtime/src/framing.js';
import {
  createOperationHandler,
  type SystemdExecutor,
} from '../../packages/terminal-runtime/src/operation-handler.js';
import {
  createRuntimeState,
  type RuntimeState,
} from '../../packages/terminal-runtime/src/runtime-state.js';
const RUNTIME_ID = '0123456789abcdef0123456789abcdef';
const OPERATION_ID = 'fedcba9876543210fedcba9876543210';
describe('terminal runtime protocol contracts', () => {
  it('accepts only immutable 128-bit lowercase hex identities', () => {
    expect(RuntimeIdSchema.parse(RUNTIME_ID)).toBe(RUNTIME_ID);
    expect(OperationIdSchema.parse(OPERATION_ID)).toBe(OPERATION_ID);
    for (const value of [
      '../matrix-gateway.service',
      '0123456789abcdef0123456789abcde ',
      '0123456789ABCDEF0123456789ABCDEF',
      '--system',
      'matrix-terminal-session@x.service',
      '0123456789abcdef0123456789abcdef0',
      '0123456789abcdef;systemctl-start',
      '',
    ]) {
      expect(RuntimeIdSchema.safeParse(value).success).toBe(false);
      expect(OperationIdSchema.safeParse(value).success).toBe(false);
    }
  });
  it('derives the one trusted template unit only after runtime validation', () => {
    expect(unitNameForRuntimeId(RUNTIME_ID)).toBe(
      `matrix-terminal-session@${RUNTIME_ID}.service`,
    );
    expect(() => unitNameForRuntimeId('../ssh')).toThrow();
    expect(() => unitNameForRuntimeId('--user')).toThrow();
  });
  it('accepts exactly the seven version-one operation shapes', () => {
    const requests = [
      {
        version: 1,
        operation: 'CreateStart',
        operationId: OPERATION_ID,
        input: {
          displayName: 'primary',
          cwd: { kind: 'home-relative', path: 'projects/matrix' },
          launch: { kind: 'shell' },
        },
      },
      {
        version: 1,
        operation: 'Inspect',
        operationId: OPERATION_ID,
        input: { runtimeId: RUNTIME_ID },
      },
      { version: 1, operation: 'List', operationId: OPERATION_ID, input: {} },
      {
        version: 1,
        operation: 'Recover',
        operationId: OPERATION_ID,
        input: { runtimeId: RUNTIME_ID },
      },
      {
        version: 1,
        operation: 'RenameMetadata',
        operationId: OPERATION_ID,
        input: { runtimeId: RUNTIME_ID, displayName: 'renamed', baseRevision: 1 },
      },
      {
        version: 1,
        operation: 'Delete',
        operationId: OPERATION_ID,
        input: { runtimeId: RUNTIME_ID },
      },
      { version: 1, operation: 'Reconcile', operationId: OPERATION_ID, input: {} },
    ];
    for (const request of requests) {
      expect(ProtocolRequestSchema.parse(request)).toEqual(request);
    }
  });
  it('rejects unknown keys and privileged injection fields', () => {
    const base = {
      version: 1,
      operation: 'Inspect',
      operationId: OPERATION_ID,
      input: { runtimeId: RUNTIME_ID },
    };
    expect(
      ProtocolRequestSchema.safeParse({ ...base, template: 'ssh.service' }).success,
    ).toBe(false);
    expect(
      ProtocolRequestSchema.safeParse({
        ...base,
        input: { ...base.input, unit: 'matrix-gateway.service' },
      }).success,
    ).toBe(false);
    expect(
      ProtocolRequestSchema.safeParse({
        version: 1,
        operation: 'StartUnit',
        operationId: OPERATION_ID,
        input: {},
      }).success,
    ).toBe(false);
    expect(
      ProtocolRequestSchema.safeParse({
        version: 1,
        operation: 'CreateStart',
        operationId: OPERATION_ID,
        input: {
          displayName: 'primary',
          launch: { kind: 'shell', command: 'bash' },
        },
      }).success,
    ).toBe(false);
  });
  it('frames strict UTF-8 JSON with one bounded big-endian message', () => {
    const value = {
      version: 1,
      operation: 'Inspect',
      operationId: OPERATION_ID,
      input: { runtimeId: RUNTIME_ID },
    };
    expect(decodeFrame(encodeFrame(value))).toEqual(value);
    const oversized = Buffer.alloc(MAX_FRAME_BYTES + 5);
    oversized.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    expect(() => decodeFrame(oversized)).toThrow('frame_too_large');
    const trailing = Buffer.concat([encodeFrame(value), Buffer.from([0])]);
    expect(() => decodeFrame(trailing)).toThrow('frame_trailing_bytes');
    const invalidUtf8 = Buffer.from([0, 0, 0, 2, 0xc3, 0x28]);
    expect(() => decodeFrame(invalidUtf8)).toThrow('frame_invalid_utf8');
    const duplicate = Buffer.from(
      `{"version":1,"operation":"List","operationId":"${OPERATION_ID}","input":{},"input":{}}`,
    );
    const duplicateFrame = Buffer.alloc(duplicate.length + 4);
    duplicateFrame.writeUInt32BE(duplicate.length, 0);
    duplicate.copy(duplicateFrame, 4);
    expect(() => decodeFrame(duplicateFrame)).toThrow('frame_duplicate_key');
    const deep = Buffer.from(`${'['.repeat(130)}0${']'.repeat(130)}`);
    const deepFrame = Buffer.alloc(deep.length + 4);
    deepFrame.writeUInt32BE(deep.length); deep.copy(deepFrame, 4);
    expect(() => decodeFrame(deepFrame)).toThrow('frame_too_complex');
  });
  it('rejects invalid requests before the systemd executor observes a call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matrix-terminal-contracts-'));
    let state: RuntimeState | undefined;
    const executor: SystemdExecutor = {
      start: vi.fn(),
      stop: vi.fn(),
      inspect: vi.fn(),
      list: vi.fn(),
    };
    try {
      state = await createRuntimeState({
        durableRoot: join(root, 'durable'),
        runtimeRoot: join(root, 'run'),
      });
      const handle = createOperationHandler({
        state, executor, resolveCwd: async (cwd) => cwd,
      });
      for (const runtimeId of [
        '../matrix-gateway',
        '--system',
        'matrix-gateway.service',
        `${RUNTIME_ID};reboot`,
        `${RUNTIME_ID}0`,
      ]) {
        await expect(handle({
          version: 1,
          operation: 'Inspect',
          operationId: OPERATION_ID,
          input: { runtimeId },
        })).resolves.toMatchObject({ ok: false, error: { code: 'invalid_request' } });
      }
      expect(executor.inspect).not.toHaveBeenCalled();
      expect(executor.start).not.toHaveBeenCalled();
      expect(executor.stop).not.toHaveBeenCalled();
    } finally {
      await state?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
