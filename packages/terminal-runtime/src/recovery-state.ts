import {
  lstat,
  readdir,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { RuntimeIdSchema } from './contracts.js';
import { SecureDirectory, isStateNotFound } from './storage.js';

const ZELLIJ_CONTRACT = 'contract_version_1';
const MAX_CONTRACT_DIRECTORIES = 32;
const MAX_RECOVERY_FILES = 4_096;
const MAX_RECOVERY_FILE_BYTES = 64 * 1024 * 1024;
const MAX_LAYOUT_BYTES = 1024 * 1024;

export type RecoveryStateKind =
  | 'valid'
  | 'missing'
  | 'corrupt'
  | 'incompatible';

export type RecoveryStateInspection = {
  state: RecoveryStateKind;
  bytes: number;
  files: number;
  updatedAtMs: number | null;
};

export type RecoveryPruneInput = {
  protectedRuntimeIds: Set<string>;
  nowMs: number;
  retentionMs: number;
  maxInactiveSets: number;
  aggregateTargetBytes: number;
  perRuntimeTargetBytes: number;
};

export type RecoveryPruneResult = {
  removedRuntimeIds: string[];
  inactiveSets: number;
  aggregateBytes: number;
};

export interface RuntimeArtifactManager {
  inspect(runtimeId: string): Promise<RecoveryStateInspection>;
  remove(runtimeId: string): Promise<void>;
  prepareFreshRecovery(runtimeId: string): Promise<void>;
  clearAgentState(runtimeId: string): Promise<void>;
  prune(input: RecoveryPruneInput): Promise<RecoveryPruneResult>;
}

function sessionName(runtimeId: string): string {
  return `matrix-t-${RuntimeIdSchema.parse(runtimeId)}`;
}

function zellijRoot(cacheRoot: string): string {
  return join(resolve(cacheRoot), 'zellij');
}

function sessionInfoRoot(cacheRoot: string, contract = ZELLIJ_CONTRACT): string {
  return join(zellijRoot(cacheRoot), contract, 'session_info');
}

export function zellijSessionStatePath(
  cacheRoot: string,
  runtimeId: string,
): string {
  return join(sessionInfoRoot(cacheRoot), sessionName(runtimeId));
}

function isMissing(error: unknown): boolean {
  return error instanceof Error &&
    'code' in error &&
    error.code === 'ENOENT';
}

function validSerializedLayout(value: string): boolean {
  if (!/\blayout\s*\{/.test(value)) return false;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let lineComment = false;
  let blockCommentDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    const next = value[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockCommentDepth > 0) {
      if (char === '/' && next === '*') {
        blockCommentDepth += 1;
        index += 1;
      } else if (char === '*' && next === '/') {
        blockCommentDepth -= 1;
        index += 1;
      }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
    } else if (char === '/' && next === '*') {
      blockCommentDepth = 1;
      index += 1;
    } else if (char === '"') {
      quoted = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && !quoted && blockCommentDepth === 0;
}

async function contractNames(cacheRoot: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(zellijRoot(cacheRoot), { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissing(error)) return [];
    throw error;
  }
  const names = entries
    .filter((entry) =>
      entry.isDirectory() &&
      /^contract_version_[0-9]{1,6}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (names.length > MAX_CONTRACT_DIRECTORIES) {
    throw new Error('recovery_contract_capacity');
  }
  return names;
}

async function incompatibleStateExists(
  cacheRoot: string,
  runtimeId: string,
): Promise<boolean> {
  for (const contract of await contractNames(cacheRoot)) {
    if (contract === ZELLIJ_CONTRACT) continue;
    try {
      const stat = await lstat(
        join(sessionInfoRoot(cacheRoot, contract), sessionName(runtimeId)),
      );
      if (stat.isDirectory() && !stat.isSymbolicLink()) return true;
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
    }
  }
  return false;
}

async function inspectCurrent(
  cacheRoot: string,
  runtimeId: string,
): Promise<RecoveryStateInspection | null> {
  const path = zellijSessionStatePath(cacheRoot, runtimeId);
  let directoryStat;
  try {
    directoryStat = await lstat(path);
  } catch (error: unknown) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    return {
      state: 'corrupt',
      bytes: 0,
      files: 0,
      updatedAtMs: directoryStat.mtimeMs,
    };
  }
  let directory: SecureDirectory | null = null;
  try {
    directory = await SecureDirectory.open(path, {
      maxEntries: MAX_RECOVERY_FILES,
    });
    const names = await directory.list();
    if (!names.includes('session-layout.kdl')) {
      return {
        state: 'corrupt',
        bytes: 0,
        files: names.length,
        updatedAtMs: directoryStat.mtimeMs,
      };
    }
    let bytes = 0;
    for (const name of names) {
      const stat = await directory.statFile(name, MAX_RECOVERY_FILE_BYTES);
      bytes += stat.size;
      if (!Number.isSafeInteger(bytes)) throw new Error('recovery_size_invalid');
    }
    const layout = (
      await directory.readBytes('session-layout.kdl', MAX_LAYOUT_BYTES)
    ).toString('utf8');
    if (!validSerializedLayout(layout)) {
      return {
        state: 'corrupt',
        bytes,
        files: names.length,
        updatedAtMs: directoryStat.mtimeMs,
      };
    }
    const contents = [
      ...layout.matchAll(/\bcontents_file\s*=\s*"(initial_contents_[0-9]+)"/g),
    ].map((match) => match[1]!);
    for (const name of contents) {
      if (!names.includes(name)) {
        return {
          state: 'corrupt',
          bytes,
          files: names.length,
          updatedAtMs: directoryStat.mtimeMs,
        };
      }
    }
    return {
      state: 'valid',
      bytes,
      files: names.length,
      updatedAtMs: directoryStat.mtimeMs,
    };
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      [
        'state_capacity',
        'state_too_large',
        'unsafe_file',
        'unsafe_file_name',
      ].includes(error.message)
    ) {
      return {
        state: 'corrupt',
        bytes: 0,
        files: 0,
        updatedAtMs: directoryStat.mtimeMs,
      };
    }
    throw error;
  } finally {
    await directory?.close();
  }
}

async function removeSessionDirectory(path: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error: unknown) {
    if (isMissing(error)) return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    await unlink(path);
    return;
  }
  if (!stat.isDirectory()) throw new Error('recovery_state_unsafe');
  const directory = await SecureDirectory.open(path, {
    maxEntries: MAX_RECOVERY_FILES,
  });
  try {
    for (const name of await directory.list()) {
      await directory.removeLeaf(name);
    }
  } finally {
    await directory.close();
  }
  await rmdir(path).catch((error: unknown) => {
    if (!isMissing(error)) throw error;
  });
}

export function createZellijRecoveryStore(options: {
  cacheRoot: string;
}): RuntimeArtifactManager {
  const cacheRoot = resolve(options.cacheRoot);

  async function inspect(
    runtimeId: string,
  ): Promise<RecoveryStateInspection> {
    const id = RuntimeIdSchema.parse(runtimeId);
    const current = await inspectCurrent(cacheRoot, id);
    if (current) return current;
    if (await incompatibleStateExists(cacheRoot, id)) {
      return {
        state: 'incompatible',
        bytes: 0,
        files: 0,
        updatedAtMs: null,
      };
    }
    return {
      state: 'missing',
      bytes: 0,
      files: 0,
      updatedAtMs: null,
    };
  }

  async function remove(runtimeId: string): Promise<void> {
    const id = RuntimeIdSchema.parse(runtimeId);
    const contracts = new Set([
      ZELLIJ_CONTRACT,
      ...(await contractNames(cacheRoot)),
    ]);
    for (const contract of contracts) {
      await removeSessionDirectory(
        join(sessionInfoRoot(cacheRoot, contract), sessionName(id)),
      );
    }
  }

  async function listCurrentRuntimeIds(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(sessionInfoRoot(cacheRoot), {
        withFileTypes: true,
      });
    } catch (error: unknown) {
      if (isMissing(error)) return [];
      throw error;
    }
    const ids = entries.flatMap((entry) => {
      const match = entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        /^matrix-t-([0-9a-f]{32})$/.exec(entry.name);
      return match ? [RuntimeIdSchema.parse(match[1])] : [];
    });
    if (ids.length > MAX_RECOVERY_FILES) {
      throw new Error('recovery_set_capacity');
    }
    return ids.sort();
  }

  return {
    inspect,
    remove,
    prepareFreshRecovery: remove,
    clearAgentState: async (runtimeId) => {
      RuntimeIdSchema.parse(runtimeId);
    },
    async prune(input) {
      const protectedIds = new Set(
        [...input.protectedRuntimeIds].map((id) => RuntimeIdSchema.parse(id)),
      );
      const entries = await Promise.all(
        (await listCurrentRuntimeIds()).map(async (runtimeId) => ({
          runtimeId,
          inspection: await inspect(runtimeId),
        })),
      );
      const inactive = entries
        .filter((entry) => !protectedIds.has(entry.runtimeId))
        .sort((left, right) =>
          (left.inspection.updatedAtMs ?? 0) -
            (right.inspection.updatedAtMs ?? 0) ||
          left.runtimeId.localeCompare(right.runtimeId));
      const removedRuntimeIds: string[] = [];
      let inactiveSets = inactive.length;
      let aggregateBytes = entries.reduce(
        (total, entry) => total + entry.inspection.bytes,
        0,
      );
      for (const entry of inactive) {
        const expired =
          entry.inspection.updatedAtMs !== null &&
          input.nowMs - entry.inspection.updatedAtMs > input.retentionMs;
        const oversized =
          entry.inspection.bytes > input.perRuntimeTargetBytes;
        const overCount = inactiveSets > input.maxInactiveSets;
        const overAggregate = aggregateBytes > input.aggregateTargetBytes;
        if (!expired && !oversized && !overCount && !overAggregate) continue;
        await remove(entry.runtimeId);
        removedRuntimeIds.push(entry.runtimeId);
        inactiveSets -= 1;
        aggregateBytes -= entry.inspection.bytes;
      }
      return { removedRuntimeIds, inactiveSets, aggregateBytes };
    },
  };
}

async function removeOwnerLeaf(
  directoryPath: string,
  name: string,
): Promise<void> {
  let stat;
  try {
    stat = await lstat(directoryPath);
  } catch (error: unknown) {
    if (isMissing(error)) return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('runtime_artifact_parent_unsafe');
  }
  const directory = await SecureDirectory.open(directoryPath, {
    maxEntries: MAX_RECOVERY_FILES,
  });
  try {
    await directory.removeLeaf(name).catch((error: unknown) => {
      if (!isStateNotFound(error)) throw error;
    });
  } finally {
    await directory.close();
  }
}

export function createRuntimeArtifactManager(options: {
  cacheRoot: string;
  scrollbackDirectory: string;
  agentStateDirectory: string;
}): RuntimeArtifactManager {
  const zellij = createZellijRecoveryStore({ cacheRoot: options.cacheRoot });
  const scrollbackDirectory = resolve(options.scrollbackDirectory);
  const agentStateDirectory = resolve(options.agentStateDirectory);

  async function removeAuxiliary(runtimeId: string): Promise<void> {
    const identity = sessionName(runtimeId);
    await removeOwnerLeaf(scrollbackDirectory, `${identity}.ndjson`);
    await removeOwnerLeaf(agentStateDirectory, `${identity}.json`);
  }

  return {
    inspect: async (runtimeId) => await zellij.inspect(runtimeId),
    async remove(runtimeId) {
      const id = RuntimeIdSchema.parse(runtimeId);
      await zellij.remove(id);
      await removeAuxiliary(id);
    },
    async prepareFreshRecovery(runtimeId) {
      const id = RuntimeIdSchema.parse(runtimeId);
      await zellij.remove(id);
      await removeOwnerLeaf(
        agentStateDirectory,
        `${sessionName(id)}.json`,
      );
    },
    async clearAgentState(runtimeId) {
      const id = RuntimeIdSchema.parse(runtimeId);
      await removeOwnerLeaf(
        agentStateDirectory,
        `${sessionName(id)}.json`,
      );
    },
    async prune(input) {
      const result = await zellij.prune(input);
      for (const runtimeId of result.removedRuntimeIds) {
        await removeAuxiliary(runtimeId);
      }
      return result;
    },
  };
}
