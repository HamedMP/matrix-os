import { lstat, readFile } from "node:fs/promises";
import { z } from "zod/v4";

/**
 * How each tab's current pane was launched (spec 2706): facts the exit sweeps
 * use to stay quiet. They live beside the workspace state, never in it: the
 * state file's strict schema is read by the previous runtime after a
 * host-bundle rollback, which keeps the owner's home and would reject any key
 * it does not know. A missing or unreadable facts file means older state.
 */
export const LAUNCH_FACT_KEYS = ["heldOnExit"] as const;
export type LaunchFactKey = (typeof LAUNCH_FACT_KEYS)[number];
export type LaunchFacts = Partial<Record<LaunchFactKey, boolean>>;

const MAX_FACTS_BYTES = 4 * 1024 * 1024;
const FactsSchema = z.object({ heldOnExit: z.boolean().optional() }).strict();
const FileSchema = z.object({ version: z.literal(1), tabs: z.record(z.string().max(256), z.unknown()) });

/** One tab incarnation: a reused tab id with a new Zellij tab name gets no stale facts. */
export function launchFactsKey(workspaceId: string, tabId: string, zellijTabName: string): string {
  return `${workspaceId}/${tabId}/${zellijTabName}`;
}

export async function readLaunchFacts(path: string): Promise<Map<string, LaunchFacts>> {
  const facts = new Map<string, LaunchFacts>();
  let raw: string;
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_FACTS_BYTES) {
      console.warn("[terminal-runtime] launch facts file ignored");
      return facts;
    }
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
      console.warn("[terminal-runtime] launch facts unreadable:", error instanceof Error ? error.name : "unknown_error");
    }
    return facts;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    console.warn("[terminal-runtime] launch facts file is not JSON; treating tabs as older state");
    return facts;
  }
  const file = FileSchema.safeParse(parsed);
  if (!file.success) return facts;
  for (const [key, value] of Object.entries(file.data.tabs)) {
    const entry = FactsSchema.safeParse(value);
    if (entry.success) facts.set(key, entry.data);
  }
  return facts;
}

export function serializeLaunchFacts(facts: ReadonlyMap<string, LaunchFacts>): string {
  return `${JSON.stringify({ version: 1, tabs: Object.fromEntries(facts) })}\n`;
}
