import { join } from 'node:path';
import { DescriptorStore } from './descriptors.js';
import { FlockManager } from './locks.js';
import {
  NameIndexStore,
  OperationRecordStore,
  ReceiptStore,
} from './receipts.js';
import { SecureDirectory } from './storage.js';

export type RuntimeState = {
  receipts: ReceiptStore;
  names: NameIndexStore;
  operations: OperationRecordStore;
  descriptors: DescriptorStore;
  locks: FlockManager;
  close(): Promise<void>;
};

async function closeResources(
  resources: Array<{ close(): Promise<void> }>,
): Promise<void> {
  const results = await Promise.allSettled(
    [...resources].reverse().map(async (resource) => resource.close()),
  );
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (errors.length > 0) throw new AggregateError(errors, 'runtime_state_close_failed');
}

export async function createRuntimeState(options: {
  durableRoot: string;
  runtimeRoot: string;
  durableOwner?: { uid: number; gid: number };
  runtimeOwner?: { uid: number; gid: number };
  authorizeDescriptorClaim?: (input: {
    runtimeId: string;
    operationId: string;
    pid: number;
  }) => Promise<boolean>;
  nowMs?: () => number;
}): Promise<RuntimeState> {
  const resources: Array<{ close(): Promise<void> }> = [];
  let durableDirectory: SecureDirectory;
  let receiptsDirectory: SecureDirectory;
  let operationsDirectory: SecureDirectory;
  let descriptorDirectory: SecureDirectory;
  let locks: FlockManager;
  try {
    durableDirectory = await SecureDirectory.open(options.durableRoot, {
      owner: options.durableOwner,
    });
    resources.push(durableDirectory);
    receiptsDirectory = await SecureDirectory.open(
      join(options.durableRoot, 'receipts'),
      { owner: options.durableOwner },
    );
    resources.push(receiptsDirectory);
    operationsDirectory = await SecureDirectory.open(
      join(options.durableRoot, 'operations'),
      { owner: options.durableOwner },
    );
    resources.push(operationsDirectory);
    descriptorDirectory = await SecureDirectory.open(
      join(options.runtimeRoot, 'descriptors'),
      { owner: options.runtimeOwner },
    );
    resources.push(descriptorDirectory);
    locks = await FlockManager.open(join(options.runtimeRoot, 'locks'));
    resources.push(locks);
  } catch (error: unknown) {
    const cleanup = await Promise.allSettled(
      [...resources].reverse().map(async (resource) => resource.close()),
    );
    const cleanupErrors = cleanup
      .filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      )
      .map((result) => result.reason);
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], 'runtime_state_open_failed');
    }
    throw error;
  }
  const descriptors = new DescriptorStore(descriptorDirectory, {
    authorizeClaim: options.authorizeDescriptorClaim ?? (async () => false),
    nowMs: options.nowMs,
  });
  return {
    receipts: new ReceiptStore(receiptsDirectory),
    names: new NameIndexStore(durableDirectory),
    operations: new OperationRecordStore(operationsDirectory),
    descriptors,
    locks,
    async close() {
      await closeResources(resources);
    },
  };
}
