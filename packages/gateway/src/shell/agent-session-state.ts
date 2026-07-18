import { chmod, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { writeUtf8FileAtomic } from "./atomic-write.js";
import { SESSION_NAME_PATTERN, validateSessionName } from "./names.js";

export const AgentKindSchema = z.enum(["claude", "codex", "opencode", "pi"]);
export type AgentKind = z.infer<typeof AgentKindSchema>;

export const AgentEventTypeSchema = z.enum([
  "turn-started",
  "attention-requested",
  "turn-completed",
  "session-ended",
  "subtitle-updated",
  "action-updated",
]);
export type AgentEventType = z.infer<typeof AgentEventTypeSchema>;

const AgentSessionPhaseSchema = z.enum(["running", "waiting", "completed", "ended"]);
export type AgentSessionPhase = z.infer<typeof AgentSessionPhaseSchema>;

export const NormalizedAgentEventSchema = z.object({
  sessionName: z.string().regex(SESSION_NAME_PATTERN),
  agent: AgentKindSchema,
  type: AgentEventTypeSchema,
  occurredAt: z.iso.datetime({ offset: true }),
  subtitle: z.string().max(4_096).optional(),
  action: z.string().max(4_096).optional(),
}).strict();
export type NormalizedAgentEvent = z.infer<typeof NormalizedAgentEventSchema>;

const AgentSessionSnapshotSchema = z.object({
  version: z.literal(1),
  sessionName: z.string().regex(SESSION_NAME_PATTERN),
  agent: AgentKindSchema,
  phase: AgentSessionPhaseSchema,
  subtitle: z.string().max(120).optional(),
  lastAction: z.string().max(160).optional(),
  agentUpdatedAt: z.iso.datetime({ offset: true }),
}).strict();
export type AgentSessionSnapshot = z.infer<typeof AgentSessionSnapshotSchema>;

const AliasFileSchema = z.object({
  version: z.literal(1),
  aliases: z.record(z.string().regex(SESSION_NAME_PATTERN), z.string().regex(SESSION_NAME_PATTERN)),
}).strict();

export type AgentDerivedVisualStatus = "running" | "waiting" | "finished" | "idle";

const ANSI_ESCAPE_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const MAX_AGENT_SNAPSHOTS = 100;
const MAX_AGENT_ALIASES = 200;

export function sanitizeAgentSubtitle(value: string): string | undefined {
  return sanitizeAgentText(value, 120);
}

export function sanitizeAgentAction(value: string): string | undefined {
  return sanitizeAgentText(value, 160);
}

function sanitizeAgentText(value: string, maxLength: number): string | undefined {
  const normalized = value
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(CONTROL_CHARACTER_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function deriveAgentVisualStatus(
  snapshot: AgentSessionSnapshot | null | undefined,
  unread: boolean,
): AgentDerivedVisualStatus | null {
  if (!snapshot) return null;
  if (snapshot.phase === "waiting") return "waiting";
  if (snapshot.phase === "running") return "running";
  return unread ? "finished" : "idle";
}

export interface AgentSessionStateStoreOptions {
  homePath: string;
  directoryPath?: string;
  maxSnapshots?: number;
  maxAliases?: number;
}

export class AgentSessionStateStore {
  private readonly directoryPath: string;
  private readonly aliasesPath: string;
  private readonly maxSnapshots: number;
  private readonly maxAliases: number;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: AgentSessionStateStoreOptions) {
    this.directoryPath = options.directoryPath ?? join(options.homePath, "system", "agent-sessions");
    this.aliasesPath = join(this.directoryPath, "aliases.json");
    this.maxSnapshots = options.maxSnapshots ?? MAX_AGENT_SNAPSHOTS;
    this.maxAliases = options.maxAliases ?? MAX_AGENT_ALIASES;
  }

  async get(name: string): Promise<AgentSessionSnapshot | null> {
    const safeName = validateSessionName(name);
    const aliases = await this.readAliases();
    return this.readSnapshot(this.resolveAlias(aliases, safeName));
  }

  async apply(rawEvent: NormalizedAgentEvent): Promise<AgentSessionSnapshot> {
    const event = NormalizedAgentEventSchema.parse(rawEvent);
    return this.withMutationLock(async () => {
      await this.ensureDirectory();
      const aliases = await this.readAliases();
      const sessionName = this.resolveAlias(aliases, event.sessionName);
      const current = await this.readSnapshot(sessionName);
      if (current && Date.parse(event.occurredAt) < Date.parse(current.agentUpdatedAt)) {
        return current;
      }

      const next: AgentSessionSnapshot = AgentSessionSnapshotSchema.parse({
        version: 1,
        sessionName,
        agent: event.agent,
        phase: phaseForEvent(event.type, current?.phase),
        ...(current?.subtitle ? { subtitle: current.subtitle } : {}),
        ...(current?.lastAction ? { lastAction: current.lastAction } : {}),
        ...(event.subtitle !== undefined
          ? optionalProperty("subtitle", sanitizeAgentSubtitle(event.subtitle))
          : {}),
        ...(event.action !== undefined
          ? optionalProperty("lastAction", sanitizeAgentAction(event.action))
          : {}),
        agentUpdatedAt: event.occurredAt,
      });
      await this.writeSnapshot(next);
      await this.enforceSnapshotBound();
      return next;
    });
  }

  async rename(fromName: string, toName: string): Promise<void> {
    const safeFrom = validateSessionName(fromName);
    const safeTo = validateSessionName(toName);
    await this.withMutationLock(async () => {
      await this.ensureDirectory();
      const aliases = await this.readAliases();
      const currentName = this.resolveAlias(aliases, safeFrom);
      const snapshot = await this.readSnapshot(currentName);
      if (snapshot) {
        await this.writeSnapshot({ ...snapshot, sessionName: safeTo });
      }
      for (const [alias, target] of Object.entries(aliases)) {
        if (target === currentName) aliases[alias] = safeTo;
      }
      aliases[safeFrom] = safeTo;
      delete aliases[safeTo];
      try {
        await this.writeAliases(this.boundAliases(aliases));
      } catch (err: unknown) {
        if (snapshot && currentName !== safeTo) {
          await this.unlinkIfPresent(this.snapshotPath(safeTo));
        }
        throw err;
      }
      if (snapshot && currentName !== safeTo) {
        await this.unlinkIfPresent(this.snapshotPath(currentName));
      }
    });
  }

  async delete(name: string): Promise<void> {
    const safeName = validateSessionName(name);
    await this.withMutationLock(async () => {
      const aliases = await this.readAliases();
      const target = this.resolveAlias(aliases, safeName);
      await this.unlinkIfPresent(this.snapshotPath(target));
      for (const [alias, aliasTarget] of Object.entries(aliases)) {
        if (alias === target || aliasTarget === target) delete aliases[alias];
      }
      if (Object.keys(aliases).length > 0) {
        await this.writeAliases(aliases);
      } else {
        await this.unlinkIfPresent(this.aliasesPath);
      }
    });
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directoryPath, { recursive: true, mode: 0o700 });
    await chmod(this.directoryPath, 0o700);
  }

  private snapshotPath(name: string): string {
    return join(this.directoryPath, `${validateSessionName(name)}.json`);
  }

  private async readSnapshot(name: string): Promise<AgentSessionSnapshot | null> {
    try {
      return AgentSessionSnapshotSchema.parse(JSON.parse(await readFile(this.snapshotPath(name), "utf8")));
    } catch (err: unknown) {
      if (isMissingFileError(err)) return null;
      throw err;
    }
  }

  private async writeSnapshot(snapshot: AgentSessionSnapshot): Promise<void> {
    await this.ensureDirectory();
    await writeUtf8FileAtomic(this.snapshotPath(snapshot.sessionName), `${JSON.stringify(snapshot, null, 2)}\n`, 0o600);
    await chmod(this.snapshotPath(snapshot.sessionName), 0o600);
  }

  private async readAliases(): Promise<Record<string, string>> {
    try {
      return AliasFileSchema.parse(JSON.parse(await readFile(this.aliasesPath, "utf8"))).aliases;
    } catch (err: unknown) {
      if (isMissingFileError(err)) return {};
      throw err;
    }
  }

  private async writeAliases(aliases: Record<string, string>): Promise<void> {
    await this.ensureDirectory();
    await writeUtf8FileAtomic(
      this.aliasesPath,
      `${JSON.stringify({ version: 1, aliases }, null, 2)}\n`,
      0o600,
    );
    await chmod(this.aliasesPath, 0o600);
  }

  private resolveAlias(aliases: Record<string, string>, name: string): string {
    let current = name;
    const visited = new Set<string>();
    while (aliases[current] && !visited.has(current)) {
      visited.add(current);
      current = aliases[current];
    }
    return current;
  }

  private boundAliases(aliases: Record<string, string>): Record<string, string> {
    const entries = Object.entries(aliases);
    return Object.fromEntries(entries.slice(Math.max(0, entries.length - this.maxAliases)));
  }

  private async enforceSnapshotBound(): Promise<void> {
    const files = (await readdir(this.directoryPath, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "aliases.json")
      .map((entry) => entry.name);
    if (files.length <= this.maxSnapshots) return;

    const snapshots = await Promise.all(files.map(async (file) => {
      try {
        return {
          file,
          snapshot: AgentSessionSnapshotSchema.parse(
            JSON.parse(await readFile(join(this.directoryPath, file), "utf8")),
          ),
        };
      } catch (err: unknown) {
        if (!(err instanceof SyntaxError) && !(err instanceof z.ZodError) && !isMissingFileError(err)) {
          throw err;
        }
        console.warn("[shell] ignored an invalid agent session snapshot during cleanup");
        return { file, snapshot: null };
      }
    }));
    snapshots.sort((left, right) => (
      (left.snapshot?.agentUpdatedAt ?? "").localeCompare(right.snapshot?.agentUpdatedAt ?? "")
    ));
    for (const entry of snapshots.slice(0, snapshots.length - this.maxSnapshots)) {
      await this.unlinkIfPresent(join(this.directoryPath, entry.file));
    }
  }

  private async unlinkIfPresent(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (err: unknown) {
      if (!isMissingFileError(err)) throw err;
    }
  }

  private async withMutationLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(fn, fn);
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}

function phaseForEvent(type: AgentEventType, current?: AgentSessionPhase): AgentSessionPhase {
  if (type === "turn-started") return "running";
  if (type === "attention-requested") return "waiting";
  if (type === "turn-completed") return "completed";
  if (type === "session-ended") return "ended";
  if (type === "action-updated" && current === "waiting") return "running";
  return current ?? "running";
}

function optionalProperty<Key extends string>(key: Key, value: string | undefined): Partial<Record<Key, string>> {
  return value === undefined ? {} : { [key]: value } as Record<Key, string>;
}

function isMissingFileError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}
