import { createHash } from 'node:crypto';
import {
  LifecycleStateSchema,
  RuntimeIdSchema,
  type LifecycleState,
} from './contracts.js';

const MAX_TELEMETRY_RUNTIMES = 2_048;
const LifecycleJournalCode = new Set([
  'runtime_created',
  'recovery_started',
  'recovery_ready',
  'recovery_fallback',
  'runtime_interrupted',
  'delete_started',
  'delete_complete',
  'reconcile_failed',
] as const);

export type RuntimeLifecycleJournalCode =
  typeof LifecycleJournalCode extends Set<infer Code> ? Code : never;

function boundedCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('telemetry_count_invalid');
  }
  return value;
}

export function summarizeRuntimeTelemetry(input: {
  runtimes: Array<{ runtimeId: string; lifecycleState: string }>;
  descriptorCount: number;
  recoveryBytes: number;
  memoryPressureEvents: number;
  taskPressureEvents: number;
}) {
  if (input.runtimes.length > MAX_TELEMETRY_RUNTIMES) {
    throw new Error('telemetry_runtime_capacity');
  }
  const counts: Partial<Record<LifecycleState, number>> = {};
  for (const runtime of input.runtimes) {
    RuntimeIdSchema.parse(runtime.runtimeId);
    const state = LifecycleStateSchema.parse(runtime.lifecycleState);
    counts[state] = (counts[state] ?? 0) + 1;
  }
  const lifecycleCounts = Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) =>
      left.localeCompare(right)),
  );
  return {
    runtimeCount: input.runtimes.length,
    lifecycleCounts,
    descriptorCount: boundedCount(input.descriptorCount),
    recoveryBytes: boundedCount(input.recoveryBytes),
    memoryPressureEvents: boundedCount(input.memoryPressureEvents),
    taskPressureEvents: boundedCount(input.taskPressureEvents),
  };
}

export function lifecycleJournalCode(
  runtimeId: string,
  code: RuntimeLifecycleJournalCode,
): { code: RuntimeLifecycleJournalCode; runtimeHash: string } {
  const id = RuntimeIdSchema.parse(runtimeId);
  if (!LifecycleJournalCode.has(code)) {
    throw new Error('lifecycle_journal_code_invalid');
  }
  return {
    code,
    runtimeHash: createHash('sha256').update(id).digest('hex').slice(0, 12),
  };
}
