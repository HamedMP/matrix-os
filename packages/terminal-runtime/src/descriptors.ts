import {
  DescriptorSchema,
  OperationIdSchema,
  RuntimeIdSchema,
  type Descriptor,
} from './contracts.js';
import { isStateNotFound, SecureDirectory } from './storage.js';
const DEFAULT_MAX_PENDING = 128;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_DESCRIPTOR_BYTES = 128 * 1024;
function pendingName(runtimeId: string, operationId: string): string {
  return `${RuntimeIdSchema.parse(runtimeId)}.${OperationIdSchema.parse(operationId)}.pending.json`;
}
function claimedName(runtimeId: string, operationId: string): string {
  return `${RuntimeIdSchema.parse(runtimeId)}.${OperationIdSchema.parse(operationId)}.claimed.json`;
}
function isInvalidDescriptorArtifact(error: unknown): boolean {
  return (
    error instanceof Error &&
    [
      'state_invalid',
      'state_too_large',
      'unsafe_file',
      'state_not_found',
    ].includes(error.message)
  );
}
export class DescriptorStore {
  private readonly authorizeClaim: (input: {
    runtimeId: string;
    operationId: string;
    pid: number;
  }) => Promise<boolean>;
  private readonly nowMs: () => number;
  private readonly maxPending: number;
  private readonly ttlMs: number;
  constructor(
    private readonly directory: SecureDirectory,
    options: {
      authorizeClaim: (input: {
        runtimeId: string;
        operationId: string;
        pid: number;
      }) => Promise<boolean>;
      nowMs?: () => number;
      maxPending?: number;
      ttlMs?: number;
    },
  ) {
    this.authorizeClaim = options.authorizeClaim;
    this.nowMs = options.nowMs ?? Date.now;
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }
  async publish(descriptor: Descriptor): Promise<void> {
    const parsed = DescriptorSchema.parse(descriptor);
    const pending = (await this.directory.list()).filter((name) =>
      name.endsWith('.pending.json'),
    );
    if (pending.length >= this.maxPending) throw new Error('descriptor_capacity');
    await this.directory.createJsonExclusive(
      pendingName(parsed.runtimeId, parsed.operationId),
      parsed,
      MAX_DESCRIPTOR_BYTES,
    );
  }
  async claim(input: {
    runtimeId: string;
    operationId: string;
    pid: number;
  }): Promise<Descriptor> {
    const runtimeId = RuntimeIdSchema.parse(input.runtimeId);
    const operationId = OperationIdSchema.parse(input.operationId);
    if (!Number.isSafeInteger(input.pid) || input.pid <= 0) {
      throw new Error('claim_unauthorized');
    }
    if (!(await this.authorizeClaim({ runtimeId, operationId, pid: input.pid }))) {
      throw new Error('claim_unauthorized');
    }
    const pending = pendingName(runtimeId, operationId);
    const claimed = claimedName(runtimeId, operationId);
    try {
      await this.directory.moveExclusive(pending, claimed);
    } catch (error: unknown) {
      if (isStateNotFound(error)) throw new Error('descriptor_not_found');
      throw error;
    }
    try {
      const parsed = DescriptorSchema.parse(
        await this.directory.readJson(claimed, MAX_DESCRIPTOR_BYTES),
      );
      if (parsed.runtimeId !== runtimeId || parsed.operationId !== operationId) {
        throw new Error('descriptor_invalid');
      }
      if (this.nowMs() - Date.parse(parsed.createdAt) > this.ttlMs) {
        throw new Error('descriptor_expired');
      }
      return parsed;
    } finally {
      await this.directory.remove(claimed).catch((error: unknown) => {
        if (!isStateNotFound(error)) throw error;
      });
    }
  }
  async remove(runtimeId: string, operationId: string): Promise<void> {
    for (const name of [
      pendingName(runtimeId, operationId),
      claimedName(runtimeId, operationId),
    ]) {
      await this.directory.remove(name).catch((error: unknown) => {
        if (!isStateNotFound(error)) throw error;
      });
    }
  }
  async removeRuntime(runtimeId: string): Promise<void> {
    const id = RuntimeIdSchema.parse(runtimeId);
    const prefix = `${id}.`;
    for (const name of await this.directory.list()) {
      if (
        name.startsWith(prefix) &&
        (name.endsWith('.pending.json') || name.endsWith('.claimed.json'))
      ) {
        await this.directory.remove(name).catch((error: unknown) => {
          if (!isStateNotFound(error)) throw error;
        });
      }
    }
  }
  async countPending(): Promise<number> {
    return (await this.directory.list()).filter((name) =>
      name.endsWith('.pending.json'),
    ).length;
  }
  async pendingKind(
    runtimeId: string,
  ): Promise<'create-pending' | 'recover-pending' | null> {
    const prefix = `${RuntimeIdSchema.parse(runtimeId)}.`;
    const names = (await this.directory.list()).filter(
      (name) => name.startsWith(prefix) && name.endsWith('.pending.json'),
    );
    for (const name of names) {
      let value: unknown;
      try {
        value = await this.directory.readJson(name, MAX_DESCRIPTOR_BYTES);
      } catch (error: unknown) {
        if (isInvalidDescriptorArtifact(error)) continue;
        throw error;
      }
      const descriptor = DescriptorSchema.safeParse(value);
      if (descriptor.success) return `${descriptor.data.intent}-pending`;
    }
    return null;
  }
  async sweep(options: {
    isActive: (input: { runtimeId: string; operationId: string }) => Promise<boolean>;
    isLocked: (input: { runtimeId: string; operationId: string }) => Promise<boolean>;
  }): Promise<number> {
    let removed = 0;
    for (const name of await this.directory.list()) {
      const match = name.match(/^([0-9a-f]{32})\.([0-9a-f]{32})\.pending\.json$/);
      if (!match) continue;
      const [, runtimeId, operationId] = match;
      if (
        (await options.isActive({ runtimeId, operationId })) ||
        (await options.isLocked({ runtimeId, operationId }))
      ) {
        continue;
      }
      let value: unknown;
      try {
        value = await this.directory.readJson(name, MAX_DESCRIPTOR_BYTES);
      } catch (error: unknown) {
        if (isInvalidDescriptorArtifact(error)) continue;
        throw error;
      }
      const parsed = DescriptorSchema.safeParse(value);
      if (!parsed.success) continue;
      const descriptor: Descriptor = parsed.data;
      if (this.nowMs() - Date.parse(descriptor.createdAt) <= this.ttlMs) continue;
      await this.directory.remove(name);
      removed += 1;
    }
    return removed;
  }
}
