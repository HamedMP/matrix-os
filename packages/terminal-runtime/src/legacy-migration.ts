import { z } from 'zod/v4';
import {
  DisplayNameSchema,
  IsoTimestampSchema,
  RuntimeIdSchema,
  createRuntimeId,
  type HomeRelativeCwd,
  type Receipt,
} from './contracts.js';
import type { RuntimeState } from './runtime-state.js';
import { isStateNotFound, SecureDirectory } from './storage.js';

const MAX_LEGACY_SOURCE_BYTES = 128 * 1024;
const MAX_LEGACY_RECORDS = 128;
const ActiveWorkspaceStatusSchema = z.enum([
  'starting',
  'running',
  'idle',
  'waiting',
]);
const LegacyShellSessionSchema = z.object({
  name: z.string().min(1).max(128),
  status: z.enum(['active', 'exited']),
  createdAt: z.string().max(64).optional(),
  cwd: z.string().max(4096).optional(),
}).passthrough();
const LegacyShellRegistrySchema = z.object({
  sessions: z.record(z.string().min(1).max(128), LegacyShellSessionSchema),
}).passthrough();
const LegacyWorkspaceSessionSchema = z.object({
  id: z.string().min(1).max(128),
  projectSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).optional(),
  worktreeId: z.string().regex(/^wt_[a-z0-9]{12,40}$/).optional(),
  runtime: z.object({
    type: z.literal('zellij'),
    status: z.string().min(1).max(32),
  }).passthrough(),
  writeMode: z.string().max(32).optional(),
}).passthrough();

type LegacyCandidate = {
  source: 'shell' | 'workspace';
  displayName: string;
  createdAt?: string;
  cwd?: string;
  priorState: 'live' | 'exited';
  workspace?: {
    fileName: string;
    raw: z.infer<typeof LegacyWorkspaceSessionSchema>;
  };
};

export type LegacyTerminalMigrationResult = {
  migrated: number;
  existing: number;
  skipped: number;
  cwdFallbacks: number;
  workspaceRecordsUpdated: number;
};

function supportedTimestamp(value: string | undefined, fallback: string): string {
  const parsed = IsoTimestampSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

async function readShellCandidates(
  systemDirectory: SecureDirectory,
): Promise<{ candidates: LegacyCandidate[]; skipped: number }> {
  let raw: unknown;
  try {
    raw = await systemDirectory.readJson(
      'shell-sessions.json',
      MAX_LEGACY_SOURCE_BYTES,
    );
  } catch (error: unknown) {
    if (isStateNotFound(error)) return { candidates: [], skipped: 0 };
    throw error;
  }
  const parsed = LegacyShellRegistrySchema.safeParse(raw);
  if (!parsed.success) throw new Error('legacy_shell_state_invalid');
  const entries = Object.entries(parsed.data.sessions);
  if (entries.length > MAX_LEGACY_RECORDS) {
    throw new Error('legacy_state_capacity');
  }
  const candidates: LegacyCandidate[] = [];
  let skipped = 0;
  for (const [key, session] of entries) {
    const displayName = DisplayNameSchema.safeParse(session.name);
    if (!displayName.success || key !== session.name) {
      skipped += 1;
      continue;
    }
    candidates.push({
      source: 'shell',
      displayName: displayName.data,
      createdAt: session.createdAt,
      cwd: session.cwd,
      priorState: session.status === 'active' ? 'live' : 'exited',
    });
  }
  return { candidates, skipped };
}

async function readWorkspaceCandidates(
  sessionsDirectory: SecureDirectory,
): Promise<{ candidates: LegacyCandidate[]; skipped: number }> {
  const candidates: LegacyCandidate[] = [];
  let skipped = 0;
  const names = (await sessionsDirectory.list())
    .filter((name) => name.endsWith('.json'));
  if (names.length > MAX_LEGACY_RECORDS) throw new Error('legacy_state_capacity');
  for (const fileName of names) {
    let raw: unknown;
    try {
      raw = await sessionsDirectory.readJson(
        fileName,
        MAX_LEGACY_SOURCE_BYTES,
      );
    } catch (error: unknown) {
      if (
        isStateNotFound(error) ||
        (error instanceof Error && error.message === 'state_invalid')
      ) {
        skipped += 1;
        continue;
      }
      throw error;
    }
    const parsed = LegacyWorkspaceSessionSchema.safeParse(raw);
    const fileId = fileName.slice(0, -'.json'.length);
    if (
      !parsed.success ||
      parsed.data.id !== fileId ||
      !DisplayNameSchema.safeParse(fileId).success ||
      !ActiveWorkspaceStatusSchema.safeParse(
        parsed.success ? parsed.data.runtime.status : '',
      ).success
    ) {
      skipped += 1;
      continue;
    }
    candidates.push({
      source: 'workspace',
      displayName: fileId,
      priorState: 'live',
      workspace: { fileName, raw: parsed.data },
    });
  }
  return { candidates, skipped };
}

async function resolveMigrationCwd(options: {
  candidate?: string;
  resolveCwd(candidate?: string): Promise<HomeRelativeCwd>;
}): Promise<{ cwd: HomeRelativeCwd; fallback: boolean }> {
  try {
    return {
      cwd: await options.resolveCwd(options.candidate),
      fallback: false,
    };
  } catch (error: unknown) {
    try {
      return { cwd: await options.resolveCwd(undefined), fallback: true };
    } catch (fallbackError: unknown) {
      throw new AggregateError(
        [error, fallbackError],
        'cwd_unavailable',
      );
    }
  }
}

function migratedReceipt(input: {
  runtimeId: string;
  candidate: LegacyCandidate;
  displayName: string;
  cwd: HomeRelativeCwd;
  now: string;
  bootId: string;
}): Receipt {
  const runtimeId = RuntimeIdSchema.parse(input.runtimeId);
  return {
    schemaVersion: 1,
    runtimeId,
    displayName: DisplayNameSchema.parse(input.displayName),
    cwd: input.cwd,
    createdAt: supportedTimestamp(input.candidate.createdAt, input.now),
    metadataRevision: 1,
    lastKnown: {
      state: input.candidate.priorState,
      at: input.now,
      bootId: input.bootId,
    },
    zellij: { sessionName: `matrix-t-${runtimeId}` },
  };
}

function collisionDisplayName(displayName: string, runtimeId: string): string {
  const id = RuntimeIdSchema.parse(runtimeId);
  const suffix = `-agent-${id}`;
  return DisplayNameSchema.parse(
    `${displayName.slice(0, 64 - suffix.length)}${suffix}`,
  );
}

async function updateWorkspaceRecord(options: {
  directory: SecureDirectory;
  candidate: LegacyCandidate;
  runtimeId: string;
}): Promise<boolean> {
  const workspace = options.candidate.workspace;
  if (!workspace) return false;
  const runtimeId = RuntimeIdSchema.parse(options.runtimeId);
  const nextRuntime = {
    ...workspace.raw.runtime,
    status: 'degraded',
    runtimeId,
    zellijSession: `matrix-t-${runtimeId}`,
    fallbackReason: 'terminal_runtime_interrupted',
  };
  if (
    JSON.stringify(workspace.raw.runtime) === JSON.stringify(nextRuntime) &&
    workspace.raw.writeMode === 'closed'
  ) return false;
  await options.directory.replaceJson(workspace.fileName, {
    ...workspace.raw,
    runtime: nextRuntime,
    writeMode: 'closed',
  }, MAX_LEGACY_SOURCE_BYTES);
  return true;
}

export async function migrateLegacyTerminalState(options: {
  homePath: string;
  state: RuntimeState;
  resolveCwd(candidate?: string): Promise<HomeRelativeCwd>;
  resolveWorkspaceCwd?(
    workspace: {
      id: string;
      projectSlug?: string;
      worktreeId?: string;
    },
  ): Promise<string | undefined>;
  now?: () => Date;
  bootId: string;
  createId?: () => string;
}): Promise<LegacyTerminalMigrationResult> {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? createRuntimeId;
  const systemDirectory = await SecureDirectory.open(
    `${options.homePath}/system`,
  );
  const sessionsDirectory = await SecureDirectory.open(
    `${options.homePath}/system/sessions`,
  );
  let migrationError: unknown;
  try {
    const [shell, workspace] = await Promise.all([
      readShellCandidates(systemDirectory),
      readWorkspaceCandidates(sessionsDirectory),
    ]);
    const candidates = [...shell.candidates, ...workspace.candidates];
    const shellDisplayNames = shell.candidates.map(
      (candidate) => candidate.displayName,
    );
    if (candidates.length > MAX_LEGACY_RECORDS) {
      throw new Error('legacy_state_capacity');
    }
    const result: LegacyTerminalMigrationResult = {
      migrated: 0,
      existing: 0,
      skipped: shell.skipped + workspace.skipped,
      cwdFallbacks: 0,
      workspaceRecordsUpdated: 0,
    };
    for (const candidate of candidates) {
      await options.state.locks.withNameIndex(async () => {
        const collidesWithShell = candidate.source === 'workspace' &&
          shellDisplayNames.includes(candidate.displayName);
        const resolved = collidesWithShell
          ? null
          : await options.state.names.resolve(
            candidate.displayName,
            now().getTime(),
          );
        let runtimeId = resolved?.runtimeId;
        if (!runtimeId && !collidesWithShell) {
          const orphan = await options.state.receipts.findByDisplayName(
            candidate.displayName,
          );
          if (orphan) {
            runtimeId = orphan.runtimeId;
            await options.state.names.register(
              candidate.displayName,
              runtimeId,
              orphan.metadataRevision,
              now().getTime(),
            );
          }
        }
        if (runtimeId) {
          result.existing += 1;
          if (await updateWorkspaceRecord({
            directory: sessionsDirectory,
            candidate,
            runtimeId,
          })) result.workspaceRecordsUpdated += 1;
          return;
        }
        let workspaceCwd: string | undefined;
        if (candidate.workspace && options.resolveWorkspaceCwd) {
          try {
            workspaceCwd = await options.resolveWorkspaceCwd({
              id: candidate.workspace.raw.id,
              ...(candidate.workspace.raw.projectSlug
                ? { projectSlug: candidate.workspace.raw.projectSlug }
                : {}),
              ...(candidate.workspace.raw.worktreeId
                ? { worktreeId: candidate.workspace.raw.worktreeId }
                : {}),
            });
          } catch (error: unknown) {
            if (!(error instanceof Error)) throw error;
            console.warn(
              '[terminal-runtime] legacy_workspace_cwd_unavailable',
            );
          }
        }
        const resolvedCwd = await resolveMigrationCwd({
          candidate: candidate.cwd ?? workspaceCwd,
          resolveCwd: options.resolveCwd,
        });
        const nextRuntimeId = RuntimeIdSchema.parse(createId());
        const nextDisplayName = collidesWithShell
          ? collisionDisplayName(candidate.displayName, nextRuntimeId)
          : candidate.displayName;
        await options.state.locks.withRuntime(
          nextRuntimeId,
          false,
          async () => {
            const timestamp = now().toISOString();
            await options.state.receipts.create(migratedReceipt({
              runtimeId: nextRuntimeId,
              candidate,
              displayName: nextDisplayName,
              cwd: resolvedCwd.cwd,
              now: timestamp,
              bootId: options.bootId,
            }));
            await options.state.names.register(
              nextDisplayName,
              nextRuntimeId,
              1,
              now().getTime(),
            );
          },
        );
        result.migrated += 1;
        if (resolvedCwd.fallback) result.cwdFallbacks += 1;
        if (await updateWorkspaceRecord({
          directory: sessionsDirectory,
          candidate,
          runtimeId: nextRuntimeId,
        })) result.workspaceRecordsUpdated += 1;
      });
    }
    return result;
  } catch (error: unknown) {
    migrationError = error;
    throw error;
  } finally {
    const closed = await Promise.allSettled([
      sessionsDirectory.close(),
      systemDirectory.close(),
    ]);
    const closeErrors = closed.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []);
    if (closeErrors.length > 0) {
      throw new AggregateError(
        migrationError === undefined
          ? closeErrors
          : [migrationError, ...closeErrors],
        'legacy_migration_close_failed',
      );
    }
  }
}
