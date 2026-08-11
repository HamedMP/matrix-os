import {
  DisplayNameSchema,
  NameIndexSchema,
  OperationIdSchema,
  OperationRecordSchema,
  ReceiptSchema,
  RuntimeIdSchema,
  type NameIndex,
  type OperationRecord,
  type Receipt,
} from './contracts.js';
import { isStateNotFound, SecureDirectory } from './storage.js';
const NAME_INDEX_FILE = 'name-index.json';
const ALIAS_TTL_MS = 24 * 60 * 60 * 1000;
function emptyNameIndex(): NameIndex {
  return { schemaVersion: 1, canonical: {}, aliases: {} };
}
function receiptFile(runtimeId: string): string {
  return `${RuntimeIdSchema.parse(runtimeId)}.json`;
}
function operationFile(operationId: string): string {
  return `operation-${OperationIdSchema.parse(operationId)}.json`;
}
export type ReceiptReadResult =
  | { kind: 'supported'; receipt: Receipt }
  | { kind: 'unsupported'; schemaVersion: number }
  | null;
export class ReceiptStore {
  constructor(private readonly directory: SecureDirectory) {}
  async create(receipt: Receipt): Promise<void> {
    const parsed = ReceiptSchema.parse(receipt);
    await this.directory.createJsonExclusive(receiptFile(parsed.runtimeId), parsed);
  }
  async replace(receipt: Receipt): Promise<void> {
    const parsed = ReceiptSchema.parse(receipt);
    await this.directory.replaceJson(receiptFile(parsed.runtimeId), parsed);
  }
  async read(runtimeId: string): Promise<ReceiptReadResult> {
    let value: unknown;
    try {
      value = await this.directory.readJson(receiptFile(runtimeId));
    } catch (error: unknown) {
      if (isStateNotFound(error)) return null;
      throw error;
    }
    const parsed = ReceiptSchema.safeParse(value);
    if (parsed.success) return { kind: 'supported', receipt: parsed.data };
    if (typeof value === 'object' && value !== null &&
      'schemaVersion' in value && typeof value.schemaVersion === 'number' &&
      Number.isInteger(value.schemaVersion) && value.schemaVersion > 1) {
      return { kind: 'unsupported', schemaVersion: value.schemaVersion };
    }
    throw new Error('state_invalid');
  }
  async list(): Promise<Array<{ runtimeId: string; state: ReceiptReadResult }>> {
    const names = (await this.directory.list()).filter((name) => /^[0-9a-f]{32}\.json$/.test(name));
    const records: Array<{ runtimeId: string; state: ReceiptReadResult }> = [];
    for (const name of names) {
      const runtimeId = name.slice(0, 32);
      records.push({ runtimeId, state: await this.read(runtimeId) });
    }
    return records;
  }
  async findByDisplayName(displayName: string): Promise<Receipt | null> {
    const name = DisplayNameSchema.parse(displayName);
    const matches = (await this.list()).flatMap(({ state }) => state?.kind ===
      'supported' && state.receipt.displayName === name ? [state.receipt] : []);
    if (matches.length > 1) throw new Error('name_conflict');
    return matches[0] ?? null;
  }
  async delete(runtimeId: string): Promise<void> {
    try {
      await this.directory.remove(receiptFile(runtimeId));
    } catch (error: unknown) {
      if (!isStateNotFound(error)) throw error;
    }
  }
}
export type NameResolution = {
  runtimeId: string;
  metadataRevision?: number;
  source: 'canonical' | 'alias';
};
export class NameIndexStore {
  constructor(private readonly directory: SecureDirectory) {}
  private async load(): Promise<NameIndex> {
    try {
      return NameIndexSchema.parse(await this.directory.readJson(NAME_INDEX_FILE));
    } catch (error: unknown) {
      if (isStateNotFound(error)) return emptyNameIndex();
      throw error;
    }
  }
  private async save(index: NameIndex): Promise<void> {
    await this.directory.replaceJson(NAME_INDEX_FILE, NameIndexSchema.parse(index));
  }
  async register(
    displayName: string,
    runtimeId: string,
    metadataRevision: number,
    nowMs: number,
  ): Promise<void> {
    const name = DisplayNameSchema.parse(displayName);
    const id = RuntimeIdSchema.parse(runtimeId);
    const index = await this.load();
    for (const [alias, target] of Object.entries(index.aliases)) {
      if (Date.parse(target.expiresAt) <= nowMs) delete index.aliases[alias];
    }
    if (index.canonical[name] || index.aliases[name]) throw new Error('name_conflict');
    index.canonical[name] = { runtimeId: id, metadataRevision };
    await this.save(index);
  }
  async resolve(displayName: string, nowMs: number): Promise<NameResolution | null> {
    const name = DisplayNameSchema.parse(displayName);
    const index = await this.load();
    const canonical = index.canonical[name];
    if (canonical) return { ...canonical, source: 'canonical' };
    const alias = index.aliases[name];
    if (!alias) return null;
    if (Date.parse(alias.expiresAt) <= nowMs) return null;
    return { runtimeId: alias.runtimeId, source: 'alias' };
  }
  async rename(input: {
    runtimeId: string;
    to: string;
    baseRevision: number;
    nowMs: number;
  }): Promise<number> {
    const runtimeId = RuntimeIdSchema.parse(input.runtimeId);
    const to = DisplayNameSchema.parse(input.to);
    const index = await this.load();
    const currentEntry = Object.entries(index.canonical).find(
      ([, target]) => target.runtimeId === runtimeId,
    );
    if (
      currentEntry?.[0] === to &&
      currentEntry[1].metadataRevision === input.baseRevision + 1
    ) {
      return currentEntry[1].metadataRevision;
    }
    if (!currentEntry) throw new Error('state_conflict');
    const [from, current] = currentEntry;
    if (
      current.runtimeId !== runtimeId ||
      current.metadataRevision !== input.baseRevision
    ) {
      throw new Error('state_conflict');
    }
    if (from === to) return current.metadataRevision;
    const existingCanonical = index.canonical[to];
    const existingAlias = index.aliases[to];
    if (
      (existingCanonical && existingCanonical.runtimeId !== runtimeId) ||
      (existingAlias &&
        existingAlias.runtimeId !== runtimeId &&
        Date.parse(existingAlias.expiresAt) > input.nowMs)
    ) {
      throw new Error('name_conflict');
    }
    const nextRevision = input.baseRevision + 1;
    delete index.canonical[from];
    delete index.aliases[to];
    index.canonical[to] = { runtimeId, metadataRevision: nextRevision };
    index.aliases[from] = {
      runtimeId,
      expiresAt: new Date(input.nowMs + ALIAS_TTL_MS).toISOString(),
    };
    await this.save(index);
    return nextRevision;
  }
  async deleteRuntime(runtimeId: string): Promise<void> {
    const id = RuntimeIdSchema.parse(runtimeId);
    const index = await this.load();
    for (const [name, target] of Object.entries(index.canonical)) {
      if (target.runtimeId === id) delete index.canonical[name];
    }
    for (const [name, target] of Object.entries(index.aliases)) {
      if (target.runtimeId === id) delete index.aliases[name];
    }
    await this.save(index);
  }
}
export class OperationRecordStore {
  private static readonly retentionMs = 7 * 86_400_000;
  private static readonly maxCompleted = 1_024;
  constructor(private readonly directory: SecureDirectory,
    private readonly nowMs: () => number = Date.now) {}
  async read(operationId: string): Promise<OperationRecord | null> {
    try {
      return OperationRecordSchema.parse(
        await this.directory.readJson(operationFile(operationId)),
      );
    } catch (error: unknown) {
      if (isStateNotFound(error)) return null;
      throw error;
    }
  }
  async commit(record: OperationRecord): Promise<OperationRecord> {
    const parsed = OperationRecordSchema.parse(record);
    const current = await this.read(parsed.operationId);
    if (current) {
      if (current.requestHash !== parsed.requestHash ||
        current.runtimeId !== parsed.runtimeId || current.intent !== parsed.intent) {
        throw new Error('operation_id_conflict');
      }
      return current;
    }
    try {
      await this.directory.createJsonExclusive(operationFile(parsed.operationId), parsed);
      return parsed;
    } catch (error: unknown) {
      if (!(error instanceof Error) || error.message !== 'state_conflict') throw error;
      const raced = await this.read(parsed.operationId);
      if (!raced || raced.requestHash !== parsed.requestHash) {
        throw new Error('operation_id_conflict');
      }
      return raced;
    }
  }
  private async listRecords(): Promise<OperationRecord[]> {
    const records: OperationRecord[] = [];
    for (const name of await this.directory.list()) {
      const match = name.match(/^operation-([0-9a-f]{32})\.json$/);
      if (!match) continue;
      const record = await this.read(match[1]);
      if (record) records.push(record);
    }
    return records;
  }
  private async pruneRecords(records: OperationRecord[], nowMs: number) {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0)
      throw new Error('operation_time_invalid');
    const completed = records.filter((record) => record.status !== 'accepted')
      .sort((left, right) => left.generation - right.generation);
    const overflow = Math.max(0,
      completed.length - OperationRecordStore.maxCompleted);
    const cutoff = nowMs - OperationRecordStore.retentionMs;
    const removed = completed.filter((record, index) => index + 1 < completed.length &&
      (index < overflow || Date.parse(record.committedAt) < cutoff));
    for (const record of removed)
      await this.directory.remove(operationFile(record.operationId));
    return removed.length;
  }
  async pruneCompleted(nowMs = this.nowMs()): Promise<number> {
    return await this.pruneRecords(await this.listRecords(), nowMs);
  }
  async nextGeneration(): Promise<number> {
    const records = await this.listRecords();
    if (records.length > OperationRecordStore.maxCompleted) await this.pruneRecords(records, this.nowMs());
    return Math.max(0, ...records.map((record) => record.generation)) + 1;
  }
  async latest(runtimeId: string, intent: OperationRecord['intent']) {
    const id = RuntimeIdSchema.parse(runtimeId);
    return (await this.listRecords())
      .filter((record) => record.runtimeId === id && record.intent === intent)
      .sort((left, right) => right.generation - left.generation)[0] ?? null;
  }
  async complete(record: OperationRecord): Promise<OperationRecord> {
    const parsed = OperationRecordSchema.parse(record);
    if (parsed.status !== 'ready' && parsed.status !== 'failed') {
      throw new Error('operation_state_conflict');
    }
    const current = await this.read(parsed.operationId);
    if (
      !current ||
      current.generation !== parsed.generation ||
      current.requestHash !== parsed.requestHash ||
      current.intent !== parsed.intent ||
      current.runtimeId !== parsed.runtimeId
    ) {
      throw new Error('operation_state_conflict');
    }
    if (current.status === 'ready' || current.status === 'failed') {
      if (JSON.stringify(current) !== JSON.stringify(parsed)) {
        throw new Error('operation_state_conflict');
      }
      return current;
    }
    await this.directory.replaceJson(operationFile(parsed.operationId), parsed);
    return parsed;
  }
  async removeCompleted(operationId: string): Promise<void> {
    const id = OperationIdSchema.parse(operationId);
    const current = await this.read(id);
    if (!current) return;
    if (current.status !== 'ready' && current.status !== 'failed') {
      throw new Error('operation_state_conflict');
    }
    await this.directory.remove(operationFile(id)).catch((error: unknown) => {
      if (!isStateNotFound(error)) throw error;
    });
  }
}
