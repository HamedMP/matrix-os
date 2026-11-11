import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { TerminalRef } from "@matrix-os/contracts";
import { z } from "zod/v4";
import { workspaceRuntimeId } from "./user-systemd-workspace.js";

/** Herdr's status words: what a program reports about itself. */
export const TerminalAgentStatusWordSchema = z.enum(["idle", "working", "done", "blocked", "error"]);
export type TerminalAgentStatusWord = z.infer<typeof TerminalAgentStatusWordSchema>;

// A pane sees zellij's own session name: the logical `matrix-w-<hex>` in a plain
// runtime, or the physical `matrix-rt_<hash>` that customer VPSes run each workspace under.
const SESSION_NAME = /^matrix-(?:w-|rt_)[0-9a-f]{32}$/;
const LOGICAL_SESSION_NAME = /^matrix-w-[0-9a-f]{32}$/;
const PANE_NUMBER = /^[0-9]{1,9}$/;
const MAX_STATUS_FILE_BYTES = 4 * 1024;
const MAX_MESSAGE_CHARS = 200;
const MAX_INDEXED_TABS = 1_024;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

const StatusFileSchema = z.object({
  version: z.literal(1),
  status: TerminalAgentStatusWordSchema,
  message: z.string().max(MAX_MESSAGE_CHARS * 4).optional(),
  reportedAt: z.iso.datetime({ offset: true }),
  source: z.enum(["reporter", "hook", "osc"]),
}).strict();

export interface TerminalAgentStatusEntry {
  ref: TerminalRef;
  status: TerminalAgentStatusWord;
  message?: string;
  reportedAt: string;
  source: "reporter" | "hook" | "osc";
}

export const TerminalAgentStatusEntrySchema = z.object({
  ref: z.object({ workspaceId: z.string(), tabId: z.string() }).strict(),
  status: TerminalAgentStatusWordSchema,
  message: z.string().max(MAX_MESSAGE_CHARS).optional(),
  reportedAt: z.string().max(64),
  source: z.enum(["reporter", "hook", "osc"]),
}).strict();

function statusDirectory(homePath: string, sessionName: string): string {
  if (!SESSION_NAME.test(sessionName)) throw new Error("Invalid terminal session name");
  return join(homePath, "system", "terminal-status", sessionName);
}

/** Where the pane with zellij pane number `paneId` (`ZELLIJ_PANE_ID`) reports its status. */
export function terminalPaneStatusPath(homePath: string, sessionName: string, paneId: string): string {
  if (!PANE_NUMBER.test(paneId)) throw new Error("Invalid terminal pane id");
  return join(statusDirectory(homePath, sessionName), `terminal_${paneId}.json`);
}

function cleanMessage(message: string | undefined): string | undefined {
  const cleaned = message?.replace(CONTROL_CHARACTERS, "").trim().slice(0, MAX_MESSAGE_CHARS);
  return cleaned ? cleaned : undefined;
}

/** Atomically record a pane's status. Identity comes from zellij's pane environment. */
export async function writeTerminalPaneStatus(input: {
  homePath: string;
  sessionName: string;
  paneId: string;
  status: TerminalAgentStatusWord;
  message?: string;
  source: TerminalAgentStatusEntry["source"];
  now?: () => Date;
}): Promise<void> {
  const target = terminalPaneStatusPath(input.homePath, input.sessionName, input.paneId);
  const directory = statusDirectory(input.homePath, input.sessionName);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("Terminal status folder is a symlink");
  const message = cleanMessage(input.message);
  const body = JSON.stringify(StatusFileSchema.parse({
    version: 1,
    status: TerminalAgentStatusWordSchema.parse(input.status),
    ...(message ? { message } : {}),
    reportedAt: (input.now?.() ?? new Date()).toISOString(),
    source: input.source,
  }));
  const temporary = join(directory, `.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  let renamed = false;
  try {
    try {
      await handle.writeFile(body, "utf8");
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    renamed = true;
  } finally {
    // Any failure after the exclusive create leaves no temporary file behind.
    if (!renamed) {
      await unlink(temporary).catch((cleanupError: unknown) => {
        console.warn("[terminal-runtime] status temp cleanup failed", cleanupError instanceof Error ? cleanupError.name : "unknown_error");
      });
    }
  }
}

/** Herdr status word for a normalized coding-agent hook event, if the event changes status. */
export function agentStatusForHookEvent(event: string): TerminalAgentStatusWord | undefined {
  switch (event) {
    case "session-started":
    case "session-ended":
      return "idle";
    case "turn-started":
    // A tool finished: the agent is working, including after a permission prompt was answered.
    case "action-updated":
      return "working";
    case "attention-requested":
      return "blocked";
    case "turn-completed":
      return "done";
    default:
      return undefined;
  }
}

interface StatusIndexStore {
  listWorkspaces(): Promise<Array<{ id: string }>>;
  getRuntimeWorkspace(workspaceId: string): Promise<{
    zellijSessionName: string;
    tabs: Record<string, { status: string; zellijPaneId: string | null }>;
  } | undefined>;
}

async function readStatusFile(path: string): Promise<z.infer<typeof StatusFileSchema> | undefined> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!stats.isFile() || stats.size > MAX_STATUS_FILE_BYTES) return undefined;
  const raw = await readFile(path, "utf8");
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch (error: unknown) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  const parsed = StatusFileSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Status of every live tab that has reported one, read from its pane's status file. */
export function createTerminalAgentStatusIndex(options: { homePath: string; store: StatusIndexStore }) {
  return {
    async list(): Promise<TerminalAgentStatusEntry[]> {
      const entries: TerminalAgentStatusEntry[] = [];
      for (const { id: workspaceId } of await options.store.listWorkspaces()) {
        const workspace = await options.store.getRuntimeWorkspace(workspaceId);
        if (!workspace || !LOGICAL_SESSION_NAME.test(workspace.zellijSessionName)) continue;
        const sessionNames = [workspace.zellijSessionName, `matrix-${workspaceRuntimeId(workspace.zellijSessionName)}`];
        for (const [tabId, tab] of Object.entries(workspace.tabs)) {
          if (entries.length >= MAX_INDEXED_TABS) return entries;
          if (tab.status === "exited" || tab.status === "failed" || !tab.zellijPaneId) continue;
          const pane = tab.zellijPaneId.slice("terminal_".length);
          // The newer report wins if both the logical and physical names have one.
          let file: z.infer<typeof StatusFileSchema> | undefined;
          for (const sessionName of sessionNames) {
            let candidate;
            try {
              candidate = await readStatusFile(terminalPaneStatusPath(options.homePath, sessionName, pane));
            } catch (error: unknown) {
              console.warn("[terminal-runtime] terminal status unreadable", error instanceof Error ? error.name : "unknown_error");
              continue;
            }
            if (candidate && (!file || Date.parse(candidate.reportedAt) > Date.parse(file.reportedAt))) file = candidate;
          }
          if (!file) continue;
          const message = cleanMessage(file.message);
          entries.push({
            ref: { workspaceId, tabId },
            status: file.status,
            ...(message ? { message } : {}),
            reportedAt: new Date(file.reportedAt).toISOString(),
            source: file.source,
          });
        }
      }
      return entries;
    },
  };
}

export type TerminalAgentStatusIndex = ReturnType<typeof createTerminalAgentStatusIndex>;
