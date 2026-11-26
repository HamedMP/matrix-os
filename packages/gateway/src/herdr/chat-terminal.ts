// A human-selected Herdr process in the canonical Chat run's own worktree.
// No input ever goes through a re-resolved tab after its authority was checked.
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { TerminalRef, TerminalWorkspace } from "@matrix-os/contracts";
import type { HcListedProcess } from "@matrix-os/herdr-core-client/sessions";
import { createTerminalAgentVerbs, TerminalAgentVerbError } from "../terminal-agent/verbs.js";
import type { TerminalInputActivity } from "../terminal-agent/input-activity.js";
import type { HerdrAttachment, HerdrScreen } from "./adapter.js";

const HUMAN_INPUT_QUIET_MS = 3000;

export interface ChatTerminalSelection {
  revision: string;
  signal: AbortSignal;
  inputActivity: TerminalInputActivity;
}

export function herdrProcessRevision(salt: string, generation: number, process: HcListedProcess, directoryId: string) {
  if (!process.identity || !isAbsolute(process.identity.cwd)) return undefined;
  return createHash("sha256").update(JSON.stringify([
    salt, generation, process.terminal.id, process.identity.pid, process.identity.created_ms, process.identity.cwd, directoryId,
  ])).digest("hex");
}

type ListedProcesses = { generation: number; terminals: HcListedProcess[] };
interface ChatTerminalSource {
  salt: string;
  inspect(): Promise<ListedProcesses>;
  current(generation: number): boolean;
  workspace(): Promise<TerminalWorkspace | null>;
  screen(id: string, lines: number): Promise<HerdrScreen>;
  writer(id: string): Promise<HerdrAttachment>;
}

export async function herdrDirectoryIdentity(path: string) {
  if (!isAbsolute(path)) return null;
  try {
    const canonical = await realpath(path);
    const entry = await stat(canonical, { bigint: true });
    return entry.isDirectory() ? JSON.stringify([canonical, String(entry.dev), String(entry.ino)]) : null;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "ELOOP") return null;
    throw error;
  }
}

export async function bindHerdrChatTerminal(
  source: ChatTerminalSource, id: string, ref: TerminalRef, root: string, selection: ChatTerminalSelection,
) {
  const { revision, inputActivity } = selection;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, selection.signal]);
  if (signal.aborted || !/^[a-f0-9]{64}$/.test(revision)) return null;
  function findProcess(list: ListedProcesses) {
    const matches = list.terminals.filter(p => p.terminal.id === id);
    return matches.length === 1 ? matches[0] : undefined;
  }
  const initial = await source.inspect();
  const selected = findProcess(initial);
  if (!selected?.identity || signal.aborted) return null;
  const selectedCwd = selected.identity.cwd;
  const [expected, actual] = await Promise.all([herdrDirectoryIdentity(root), herdrDirectoryIdentity(selectedCwd)]);
  if (!expected || actual !== expected || signal.aborted || !source.current(initial.generation)
    || herdrProcessRevision(source.salt, initial.generation, selected, expected) !== revision) return null;

  function fence() {
    if (!source.current(initial.generation) || signal.aborted) throw new TerminalAgentVerbError("not_found");
  }
  async function check() {
    fence();
    const [list, currentRoot, currentCwd] = await Promise.all([
      source.inspect(), herdrDirectoryIdentity(root), herdrDirectoryIdentity(selectedCwd),
    ]);
    fence();
    const process = findProcess(list);
    if (!process || list.generation !== initial.generation || expected !== currentRoot || expected !== currentCwd
      || herdrProcessRevision(source.salt, list.generation, process, expected!) !== revision) {
      controller.abort();
      throw new TerminalAgentVerbError("not_found");
    }
    return process.terminal.status;
  }

  const verbs = createTerminalAgentVerbs({
    inputActivity, quietMs: HUMAN_INPUT_QUIET_MS,
    agentStatus: async () => (await check()) ?? undefined,
    runtime: {
      async listWorkspaces() {
        await check();
        const workspace = await source.workspace();
        return workspace ? [workspace] : [];
      },
      getSnapshot: async () => undefined,
      async captureScreen(_ref, lines) {
        await check();
        const screen = await source.screen(id, lines);
        await check();
        return screen;
      },
      async writeInput(_ref, data) {
        // Pin the attachment first. A changing process or connection cannot
        // redirect these bytes to a new session between the check and the write.
        const writer = await source.writer(id);
        try {
          const status = await check();
          fence();
          if (data !== "\x1b" && data !== "\x03") {
            if (status === "blocked") throw new TerminalAgentVerbError("blocked");
            const last = inputActivity.lastInputAt(ref);
            if (last !== undefined && Date.now() - last < HUMAN_INPUT_QUIET_MS) throw new TerminalAgentVerbError("cancelled");
          }
          if (!writer.input(data)) throw new TerminalAgentVerbError("not_found");
        } finally { writer.detach(); }
      },
    },
  });
  return {
    async check() { await check(); },
    async read(lines: number) {
      const result = await verbs.read(ref, { lines });
      await check();
      return result;
    },
    send: (text: string) => verbs.send(ref, { text, maxHoldMs: 0, deferWhileTyping: true, signal }),
    interrupt: () => verbs.interrupt(ref, { signal }),
    close: () => controller.abort(),
  };
}
