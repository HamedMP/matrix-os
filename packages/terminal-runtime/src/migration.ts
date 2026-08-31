import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ProjectIdSchema, TerminalRefSchema, type TerminalRef } from "@matrix-os/contracts";
import { z } from "zod/v4";
import { TerminalWorkspaceStore } from "./workspace-store.js";

const MAX_LEGACY_STATE_BYTES = 16 * 1024 * 1024;
const MAX_REFERENCE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_LEGACY_SCROLLBACK_BYTES = 5 * 1024 * 1024;
const MAX_REFERENCE_FILES = 1_024;
const JOURNAL_NAME = "terminal-migration-journal.json";
const STATE_NAME = "terminal-workspaces.json";
const STAGED_STATE_NAME = "terminal-workspaces.staged.json";
const LegacyScrollbackRecordSchema = z.union([
  z.object({
    type: z.literal("output"),
    seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    data: z.string().max(MAX_LEGACY_SCROLLBACK_BYTES),
  }).passthrough(),
  z.object({
    type: z.enum(["block-mark", "seq-reserve"]),
    seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }).passthrough(),
]);

const LegacySessionSchema = z.object({
  name: z.string().min(1).max(128),
  status: z.enum(["active", "exited"]),
  createdAt: z.string().datetime({ offset: true }).optional(),
  cwd: z.string().max(4096).optional(),
  projectId: ProjectIdSchema.optional(),
  layoutName: z.string().min(1).max(120).optional(),
  tabs: z.array(z.object({
    idx: z.number().int().min(0),
    name: z.string().min(1).max(120).optional(),
    focused: z.boolean().optional(),
    createdAt: z.string().datetime({ offset: true }).optional(),
  }).passthrough()).max(1_000).optional(),
  placement: z.enum(["active", "background"]).optional(),
  lastSeenSeq: z.number().int().min(0).nullable().optional(),
  agent: z.enum(["claude", "codex", "opencode", "pi"]).optional(),
}).passthrough();
const LegacyRegistrySchema = z.object({
  sessions: z.record(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), LegacySessionSchema),
}).passthrough();
const JournalSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum([
    "staging",
    "staged",
    "stopped",
    "activating",
    "committed",
    "rolling_back",
    "rolled_back",
    "failed",
  ]),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  legacySessionNames: z.array(z.string().min(1).max(128)).max(10_000),
  terminalRefs: z.record(z.string().min(1).max(128), TerminalRefSchema),
  backups: z.record(z.string().min(1).max(4096), z.string().max(MAX_LEGACY_SCROLLBACK_BYTES)),
  generatedPaths: z.array(z.string().min(1).max(4096)).max(20_000),
}).strict();

type Journal = z.infer<typeof JournalSchema>;

export interface LegacyZellijCutover {
  stopLegacySessions(names: string[]): Promise<void>;
  ensureWorkspace(sessionName: string, size: { cols: number; rows: number }): Promise<void>;
  createShellTab(sessionName: string, input: {
    internalName: string;
    cwd: string;
    command?: never;
  }): Promise<{ tabId: number; paneId: string }>;
  findTabByInternalName?(sessionName: string, internalName: string): Promise<{ tabId: number; paneId: string } | undefined>;
  stopWorkspaceSessions?(sessionNames: string[]): Promise<void>;
}

export interface TerminalMigrationProject {
  id: string;
  cwd: string;
}

export interface TerminalMigrationResult {
  status: "committed" | "already_committed";
  migratedTabs: number;
  stoppedLegacySessions: number;
}

export async function migrateTerminalWorkspaces(options: {
  homePath: string;
  projects: TerminalMigrationProject[];
  cutover: LegacyZellijCutover;
  now?: () => Date;
}): Promise<TerminalMigrationResult> {
  const now = options.now ?? (() => new Date());
  const systemPath = join(options.homePath, "system");
  const finalStatePath = join(systemPath, STATE_NAME);
  const stagedStatePath = join(systemPath, STAGED_STATE_NAME);
  const journalPath = join(systemPath, JOURNAL_NAME);
  await mkdir(systemPath, { recursive: true, mode: 0o700 });

  let journal = await readJournalIfPresent(journalPath);
  if (journal?.status === "rolling_back") {
    await completeTerminalWorkspaceRollback({
      homePath: options.homePath,
      cutover: options.cutover,
      journal,
      journalPath,
      now,
    });
    journal = await readJournalIfPresent(journalPath);
  }

  const committedState = await readJsonIfPresent(finalStatePath, MAX_LEGACY_STATE_BYTES);
  if (isSchemaV2State(committedState)) {
    if (journal && journal.status !== "committed") {
      journal.status = "committed";
      journal.updatedAt = now().toISOString();
      await writeJsonAtomic(journalPath, journal);
    }
    return {
      status: "already_committed",
      migratedTabs: Object.keys(journal?.terminalRefs ?? {}).length,
      stoppedLegacySessions: journal?.legacySessionNames.length ?? 0,
    };
  }
  if (committedState !== undefined) throw new Error("terminal_state_corrupt");

  const registryPath = join(systemPath, "shell-sessions.json");
  const legacyRaw = await readJsonIfPresent(registryPath, MAX_LEGACY_STATE_BYTES) ?? { sessions: {} };
  const legacy = LegacyRegistrySchema.parse(legacyRaw);
  const entries = Object.entries(legacy.sessions);
  if (entries.length > 10_000) throw new Error("legacy_terminal_capacity");
  if (!journal || journal.status === "rolled_back" || journal.status === "failed") {
    const timestamp = now().toISOString();
    journal = {
      schemaVersion: 1,
      status: "staging",
      createdAt: timestamp,
      updatedAt: timestamp,
      legacySessionNames: entries.map(([legacyId]) => legacyId),
      terminalRefs: {},
      backups: { [relative(options.homePath, registryPath)]: JSON.stringify(legacyRaw) },
      generatedPaths: [],
    };
    await writeJsonAtomic(journalPath, journal);
  }

  const projects = options.projects.map((project) => ({
    id: ProjectIdSchema.parse(project.id),
    cwd: canonicalRelativeCwd(options.homePath, project.cwd),
  }));
  if (journal.status === "committed") throw new Error("terminal_state_corrupt");
  if (["staged", "stopped", "activating"].includes(journal.status)) {
    const stagedState = await readJsonIfPresent(stagedStatePath, MAX_LEGACY_STATE_BYTES);
    if (!isSchemaV2State(stagedState)) throw new Error("terminal_state_corrupt");
  }
  const stagedStore = new TerminalWorkspaceStore({ homePath: options.homePath, statePath: stagedStatePath, now });
  if (journal.status === "staging") {
    await stagedStore.ensureWorkspace();
    for (const [legacyId, session] of entries) {
      const projectId = classifyProject(session, projects, options.homePath);
      const workspace = await stagedStore.ensureWorkspace(projectId ? { projectId } : {});
      const tab = await stagedStore.createMigratedTab(workspace.id, {
        migrationKey: legacyId,
        name: session.name,
        cwd: canonicalRelativeCwd(options.homePath, session.cwd ?? ""),
        createdAt: session.createdAt,
        ...(session.agent ? { agent: { providerId: session.agent } } : {}),
        uiState: {
          placement: session.placement ?? "active",
          lastSeenSeq: session.lastSeenSeq ?? null,
          ...(session.layoutName ? { layoutName: session.layoutName } : {}),
          ...(session.tabs ? {
            legacyTabs: session.tabs.map((tab) => ({
              ...(tab.name ? { name: tab.name } : {}),
              ...(tab.focused === undefined ? {} : { focused: tab.focused }),
              ...(tab.createdAt ? { createdAt: tab.createdAt } : {}),
            })),
          } : {}),
        },
      });
      journal.terminalRefs[legacyId] = { workspaceId: workspace.id, tabId: tab.id };
      await migrateNameScopedState(
        options.homePath,
        legacyId,
        journal.terminalRefs[legacyId],
        stagedStore,
        journal,
        journalPath,
        now,
      );
      journal.updatedAt = now().toISOString();
      await writeJsonAtomic(journalPath, journal);
    }
    await stageReferenceRewrites(options.homePath, journal, journalPath, now);
    journal.status = "staged";
    journal.updatedAt = now().toISOString();
    await writeJsonAtomic(journalPath, journal);
  }

  if (journal.status === "staged") {
    await options.cutover.stopLegacySessions(journal.legacySessionNames);
    journal.status = "stopped";
    journal.updatedAt = now().toISOString();
    await writeJsonAtomic(journalPath, journal);
  }
  if (journal.status === "stopped" || journal.status === "activating") {
    journal.status = "activating";
    journal.updatedAt = now().toISOString();
    await writeJsonAtomic(journalPath, journal);
    for (const workspace of await stagedStore.listWorkspaces()) {
      const internal = await stagedStore.getRuntimeWorkspace(workspace.id);
      if (!internal) throw new Error("staged_workspace_missing");
      await options.cutover.ensureWorkspace(internal.zellijSessionName, internal.canonicalSize);
      for (const tab of Object.values(internal.tabs).sort((left, right) => left.order - right.order)) {
        const ref = { workspaceId: internal.id, tabId: tab.id };
        let ids = await options.cutover.findTabByInternalName?.(internal.zellijSessionName, tab.zellijTabName);
        ids ??= tab.zellijTabId !== null && tab.zellijPaneId !== null
          ? { tabId: tab.zellijTabId, paneId: tab.zellijPaneId }
          : undefined;
        ids ??= await options.cutover.createShellTab(internal.zellijSessionName, {
          internalName: tab.zellijTabName,
          cwd: tab.cwd,
        });
        await stagedStore.activateTab(ref, ids);
      }
    }
    await renameDurable(stagedStatePath, finalStatePath);
    journal.status = "committed";
    journal.updatedAt = now().toISOString();
    await writeJsonAtomic(journalPath, journal);
  }
  return {
    status: "committed",
    migratedTabs: Object.keys(journal.terminalRefs).length,
    stoppedLegacySessions: journal.legacySessionNames.length,
  };
}

export async function rollbackTerminalWorkspaceMigration(options: {
  homePath: string;
  cutover: LegacyZellijCutover;
  now?: () => Date;
}): Promise<void> {
  const now = options.now ?? (() => new Date());
  const systemPath = join(options.homePath, "system");
  const journalPath = join(systemPath, JOURNAL_NAME);
  const journal = await readJournalIfPresent(journalPath);
  if (!journal) throw new Error("terminal_migration_backup_missing");
  if (journal.status === "rolled_back") return;
  if (journal.status !== "rolling_back") {
    journal.status = "rolling_back";
    journal.updatedAt = now().toISOString();
    await writeJsonAtomic(journalPath, journal);
  }
  await completeTerminalWorkspaceRollback({
    homePath: options.homePath,
    cutover: options.cutover,
    journal,
    journalPath,
    now,
  });
}

async function completeTerminalWorkspaceRollback(options: {
  homePath: string;
  cutover: LegacyZellijCutover;
  journal: Journal;
  journalPath: string;
  now: () => Date;
}): Promise<void> {
  const systemPath = join(options.homePath, "system");
  const stores = [
    new TerminalWorkspaceStore({ homePath: options.homePath }),
    new TerminalWorkspaceStore({
      homePath: options.homePath,
      statePath: join(systemPath, STAGED_STATE_NAME),
    }),
  ];
  const zellijNames = new Set<string>();
  for (const store of stores) {
    const workspaceIds = (await store.listWorkspaces()).map((workspace) => workspace.id);
    const workspaces = await Promise.all(workspaceIds.map((id) => store.getRuntimeWorkspace(id)));
    for (const workspace of workspaces) {
      if (workspace) zellijNames.add(workspace.zellijSessionName);
    }
  }
  await options.cutover.stopWorkspaceSessions?.([...zellijNames]);
  for (const [relativePath, content] of Object.entries(options.journal.backups)) {
    await writeTextAtomic(resolveWithinHome(options.homePath, relativePath), content);
  }
  for (const relativePath of options.journal.generatedPaths) {
    await removeDurable(resolveWithinHome(options.homePath, relativePath));
  }
  await removeDurable(join(systemPath, STATE_NAME));
  await removeDurable(join(systemPath, STAGED_STATE_NAME));
  options.journal.status = "rolled_back";
  options.journal.updatedAt = options.now().toISOString();
  await writeJsonAtomic(options.journalPath, options.journal);
}

function classifyProject(
  session: z.infer<typeof LegacySessionSchema>,
  projects: Array<{ id: string; cwd: string }>,
  homePath: string,
): string | undefined {
  if (session.projectId && projects.some((project) => project.id === session.projectId)) return session.projectId;
  const cwd = canonicalRelativeCwd(homePath, session.cwd ?? "");
  const matches = projects.filter((project) => cwd === project.cwd || cwd.startsWith(`${project.cwd}/`));
  return matches.length === 1 ? matches[0]!.id : undefined;
}

async function migrateNameScopedState(
  homePath: string,
  legacyName: string,
  ref: TerminalRef,
  stagedStore: TerminalWorkspaceStore,
  journal: Journal,
  journalPath: string,
  now: () => Date,
): Promise<void> {
  const migrations = [
    { source: join("system", "shell-preferences", `${legacyName}.json`), target: join("system", "terminal-tabs", ref.tabId, "preferences.json"), json: true },
    { source: join("system", "agent-sessions", `${legacyName}.json`), target: join("system", "terminal-tabs", ref.tabId, "agent.json"), json: true },
  ];
  for (const migration of migrations) {
    const source = join(homePath, migration.source);
    const content = await readTextIfPresent(source, MAX_REFERENCE_FILE_BYTES);
    if (content === undefined) continue;
    journal.backups[migration.source] ??= content;
    let next = content;
    if (migration.json) {
      next = `${JSON.stringify(rewriteTerminalRefs(JSON.parse(content), { [legacyName]: ref }), null, 2)}\n`;
    }
    if (!journal.generatedPaths.includes(migration.target)) journal.generatedPaths.push(migration.target);
    journal.updatedAt = now().toISOString();
    await writeJsonAtomic(journalPath, journal);
    await writeTextAtomic(join(homePath, migration.target), next);
  }
  await migrateLegacyScrollback(homePath, legacyName, ref, stagedStore, journal, journalPath, now);
}

async function migrateLegacyScrollback(
  homePath: string,
  legacyName: string,
  ref: TerminalRef,
  stagedStore: TerminalWorkspaceStore,
  journal: Journal,
  journalPath: string,
  now: () => Date,
): Promise<void> {
  const source = join("system", "scrollback", `${legacyName}.ndjson`);
  const content = await readTextIfPresent(join(homePath, source), MAX_LEGACY_SCROLLBACK_BYTES);
  if (content === undefined) return;
  const target = join("system", "terminal-workspaces", "scrollback", `${ref.tabId}.json`);
  journal.backups[source] ??= content;
  if (!journal.generatedPaths.includes(target)) journal.generatedPaths.push(target);
  journal.updatedAt = now().toISOString();
  await writeJsonAtomic(journalPath, journal);

  const records: Array<z.infer<typeof LegacyScrollbackRecordSchema>> = [];
  let malformedRecords = 0;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = LegacyScrollbackRecordSchema.safeParse(JSON.parse(line));
      if (parsed.success) records.push(parsed.data);
      else malformedRecords += 1;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      malformedRecords += 1;
    }
  }
  if (malformedRecords > 0) {
    console.warn("[terminal-runtime] skipped malformed legacy scrollback records", {
      count: malformedRecords,
    });
  }
  const ansi = records
    .filter((record): record is z.infer<typeof LegacyScrollbackRecordSchema> & { type: "output"; data: string } => record.type === "output")
    .sort((left, right) => left.seq - right.seq)
    .map((record) => record.data)
    .join("");
  const lines = ansi.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const scrollback = lines
    .flatMap((line) => line.length <= 16_384
      ? [line]
      : Array.from({ length: Math.ceil(line.length / 16_384) }, (_, index) => (
          line.slice(index * 16_384, (index + 1) * 16_384)
        )))
    .slice(-100_000);
  await stagedStore.importSnapshot(ref, {
    ansi,
    viewport: [],
    scrollback,
    seq: records.reduce((latest, record) => Math.max(latest, record.seq), 0),
  });
}

async function stageReferenceRewrites(
  homePath: string,
  journal: Journal,
  journalPath: string,
  now: () => Date,
): Promise<void> {
  const systemPath = join(homePath, "system");
  const candidates = [
    join(systemPath, "terminal-layouts.json"),
    join(systemPath, "desktop.json"),
    join(systemPath, "canvas.json"),
    join(systemPath, "coding-agent-threads.json"),
    ...(await collectJsonFiles(join(systemPath, "sessions"))),
    ...(await collectJsonFiles(join(systemPath, "agent-sessions"))),
  ];
  const planned: Array<{ path: string; content: string }> = [];
  for (const path of [...new Set(candidates)].slice(0, MAX_REFERENCE_FILES)) {
    const content = await readTextIfPresent(path, MAX_REFERENCE_FILE_BYTES);
    if (content === undefined) continue;
    const rewritten = rewriteTerminalRefs(JSON.parse(content), journal.terminalRefs);
    const next = `${JSON.stringify(rewritten, null, 2)}\n`;
    if (next === content || JSON.stringify(JSON.parse(content)) === JSON.stringify(rewritten)) continue;
    const relativePath = relative(homePath, path);
    journal.backups[relativePath] ??= content;
    planned.push({ path, content: next });
  }
  if (planned.length > 0) {
    journal.updatedAt = now().toISOString();
    await writeJsonAtomic(journalPath, journal);
  }
  for (const rewrite of planned) {
    await writeTextAtomic(rewrite.path, rewrite.content);
  }
}

function rewriteTerminalRefs(value: unknown, refs: Record<string, TerminalRef>): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteTerminalRefs(item, refs));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === "terminalSessionId" && typeof child === "string" && refs[child]) {
      next.terminalRef = refs[child];
    } else {
      next[key] = rewriteTerminalRefs(child, refs);
    }
  }
  if (record.kind === "terminal_session" && typeof record.id === "string" && refs[record.id]) {
    delete next.id;
    next.kind = "terminal_tab";
    next.terminalRef = refs[record.id];
  }
  return next;
}

async function collectJsonFiles(directory: string): Promise<string[]> {
  try {
    const files = await readdir(directory, { withFileTypes: true });
    return files.filter((file) => file.isFile() && !file.isSymbolicLink() && file.name.endsWith(".json"))
      .map((file) => join(directory, file.name));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function canonicalRelativeCwd(homePath: string, cwd: string): string {
  if (cwd === "" || cwd === homePath) return "";
  const normalized = cwd.startsWith(`${homePath}${sep}`) ? relative(homePath, cwd) : cwd;
  if (normalized.startsWith("/") || normalized.includes("\0") || normalized.includes("\\")) return "";
  if (normalized.split("/").some((part) => part === "" || part === "." || part === "..")) return "";
  return normalized;
}

function resolveWithinHome(homePath: string, relativePath: string): string {
  const target = resolve(homePath, relativePath);
  const root = `${resolve(homePath)}${sep}`;
  if (!target.startsWith(root)) throw new Error("migration_path_invalid");
  return target;
}

async function readJournalIfPresent(path: string): Promise<Journal | undefined> {
  const raw = await readJsonIfPresent(path, MAX_LEGACY_STATE_BYTES);
  return raw === undefined ? undefined : JournalSchema.parse(raw);
}

async function readJsonIfPresent(path: string, maxBytes: number): Promise<unknown | undefined> {
  const content = await readTextIfPresent(path, maxBytes);
  return content === undefined ? undefined : JSON.parse(content);
}

async function readTextIfPresent(path: string, maxBytes: number): Promise<string | undefined> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > maxBytes) throw new Error("migration_state_invalid");
    return readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function renameDurable(sourcePath: string, targetPath: string): Promise<void> {
  await rename(sourcePath, targetPath);
  await syncDirectory(dirname(targetPath));
}

async function removeDurable(path: string): Promise<void> {
  await rm(path, { force: true });
  try {
    await syncDirectory(dirname(path));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directoryHandle = await open(path, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function writeTextAtomic(path: string, content: string): Promise<void> {
  const directoryPath = dirname(path);
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    await syncDirectory(directoryPath);
  } catch (error) {
    try {
      await rm(temporaryPath, { force: true });
    } catch (cleanupError) {
      console.error(
        "terminal migration temporary-file cleanup failed",
        cleanupError instanceof Error ? cleanupError.name : "unknown_error",
      );
    }
    throw error;
  }
}

function isSchemaV2State(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as { schemaVersion?: unknown }).schemaVersion === 2);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
