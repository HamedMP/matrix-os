import { mkdir, readFile, rename, open, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { TerminalRefSchema, type TerminalRef } from "@matrix-os/contracts";
import { z } from "zod/v4";
import { terminalRefKey } from "./status-source.js";

export const MAX_TERMINAL_LABELS = 32;
export const TerminalLabelKeySchema = z.string().regex(/^[a-z][a-z0-9_.-]{0,62}$/);
export const TerminalLabelValueSchema = z.string().max(256).regex(/^[^\u0000-\u001f\u007f]*$/);
const MAX_AGENTS = 1_024;

const FirstMessageSchema = z.object({
  sent: z.boolean(),
  reason: z.enum(["not_ready", "blocked", "finished", "failed"]).optional(),
}).strict();
export type TerminalFirstMessage = z.infer<typeof FirstMessageSchema>;

const AgentRecordSchema = z.object({
  ref: TerminalRefSchema,
  incarnation: z.string().regex(/^ti_[a-f0-9]{32}$/).optional(),
  labels: z.record(TerminalLabelKeySchema, TerminalLabelValueSchema),
  parent: TerminalRefSchema.optional(),
  outliveParent: z.boolean(),
  template: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).optional(),
  firstMessage: FirstMessageSchema.optional(),
  createdAt: z.iso.datetime({ offset: true }),
}).strict();
export type TerminalAgentRecord = z.infer<typeof AgentRecordSchema>;

const FileSchema = z.object({
  version: z.literal(1),
  agents: z.array(AgentRecordSchema).max(MAX_AGENTS),
}).strict();

export interface TerminalAgentRegistry {
  get(ref: TerminalRef): Promise<TerminalAgentRecord | undefined>;
  list(): Promise<TerminalAgentRecord[]>;
  children(parent: TerminalRef): Promise<TerminalAgentRecord[]>;
  upsert(ref: TerminalRef, update: (current: TerminalAgentRecord) => TerminalAgentRecord): Promise<TerminalAgentRecord>;
  /** Forget records whose tabs no longer exist. */
  prune(liveKeys: ReadonlySet<string>): Promise<number>;
}

/**
 * Herdr-style agent facts Matrix keeps beside each tab: labels, the parent that
 * started it, its template and whether its first message arrived. Stored as one
 * owner file, `~/system/terminal-agents.json`, written atomically and capped.
 */
export function createTerminalAgentRegistry(options: { homePath: string; now?: () => Date }): TerminalAgentRegistry {
  const path = join(options.homePath, "system", "terminal-agents.json");
  const now = options.now ?? (() => new Date());
  let chain: Promise<unknown> = Promise.resolve();

  async function load(): Promise<TerminalAgentRecord[]> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error;
      console.warn("[gateway] terminal agent registry is not JSON; starting empty");
      return [];
    }
    const parsed = FileSchema.safeParse(value);
    if (!parsed.success) {
      console.warn("[gateway] terminal agent registry is invalid; starting empty");
      return [];
    }
    return parsed.data.agents;
  }

  async function save(agents: TerminalAgentRecord[]): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    const body = JSON.stringify(FileSchema.parse({ version: 1, agents }));
    const handle = await open(temporary, "wx", 0o600);
    let renamed = false;
    try {
      try { await handle.writeFile(body, "utf8"); }
      finally { await handle.close(); }
      await rename(temporary, path);
      renamed = true;
    } finally {
      // Any failure after the exclusive create leaves no temporary file behind.
      if (!renamed) {
        await unlink(temporary).catch((cleanupError: unknown) => {
          console.warn("[gateway] terminal agent registry temp cleanup failed", cleanupError instanceof Error ? cleanupError.name : "unknown_error");
        });
      }
    }
  }

  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = chain.then(operation, operation);
    // The caller receives the failure through `next`; the queue only has to keep going.
    chain = next.then(
      () => undefined,
      (error: unknown) => { console.warn("[gateway] terminal agent registry write failed", error instanceof Error ? error.name : "unknown_error"); },
    );
    return next;
  }

  return {
    async get(ref) {
      const key = terminalRefKey(ref);
      return (await serialized(load)).find((record) => terminalRefKey(record.ref) === key);
    },
    list: () => serialized(load),
    async children(parent) {
      const key = terminalRefKey(parent);
      return (await serialized(load)).filter((record) => record.parent && terminalRefKey(record.parent) === key);
    },
    upsert(refInput, update) {
      const ref = TerminalRefSchema.parse(refInput);
      return serialized(async () => {
        const agents = await load();
        const key = terminalRefKey(ref);
        const index = agents.findIndex((record) => terminalRefKey(record.ref) === key);
        const current = index >= 0 ? agents[index]! : {
          ref, labels: {}, outliveParent: false, createdAt: now().toISOString(),
        };
        const next = AgentRecordSchema.parse(update(structuredClone(current)));
        if (Object.keys(next.labels).length > MAX_TERMINAL_LABELS) throw new z.ZodError([{ code: "custom", path: ["labels"], message: "Too many labels" }]);
        if (index >= 0) agents[index] = next;
        else agents.push(next);
        // Oldest records go first when the cap is reached; live tabs re-register on use.
        while (agents.length > MAX_AGENTS) agents.shift();
        await save(agents);
        return next;
      });
    },
    prune(liveKeys) {
      return serialized(async () => {
        const agents = await load();
        const kept = agents.filter((record) => liveKeys.has(terminalRefKey(record.ref)));
        if (kept.length !== agents.length) await save(kept);
        return agents.length - kept.length;
      });
    },
  };
}
