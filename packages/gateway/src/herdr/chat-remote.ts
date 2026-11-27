import { isAbsolute, normalize } from "node:path";
import { WorktreeIdSchema } from "@matrix-os/contracts";
import { TerminalControlMachineSchema } from "@matrix-os/contracts/herdr-terminals";
import type { HerdrSessionHost } from "@matrix-os/herdr-core-client/session-host";
import type { HcListedProcess } from "@matrix-os/herdr-core-client/sessions";
import { z } from "zod/v4";
import { herdrProcessRevision } from "./chat-terminal.js";

const CheckoutPath = z.string().min(2).max(4096).refine(path =>
  !path.includes("\0") && isAbsolute(path) && normalize(path) === path && !path.endsWith("/"));
const RemoteWorktree = z.strictObject({
  machine: TerminalControlMachineSchema,
  machineId: z.string().regex(/^[a-f0-9]{32}$/),
  worktreeId: WorktreeIdSchema,
  localRoot: CheckoutPath,
  remoteRoot: CheckoutPath,
});
export type HerdrChatRemoteWorktree = z.infer<typeof RemoteWorktree>;

/** Host-owned allowlist. A bad or ambiguous configuration grants no remote access. */
export function readHerdrChatRemoteWorktrees(value: string | undefined): HerdrChatRemoteWorktree[] {
  if (!value) return [];
  try {
    const rows = z.array(RemoteWorktree).max(16).parse(JSON.parse(value));
    const sources = new Set(rows.map(row => JSON.stringify([row.machine, row.worktreeId])));
    const targets = new Set(rows.map(row => JSON.stringify([row.machine, row.remoteRoot])));
    if (sources.size === rows.length && targets.size === rows.length) return rows;
    console.warn("[terminal-control] Duplicate worktree route");
  } catch (error: unknown) {
    console.warn("[terminal-control] Invalid remote worktree configuration", error instanceof Error ? error.name : "UnknownError");
  }
  return [];
}

type RemoteProcessList = Awaited<ReturnType<HerdrSessionHost["listRemoteProcesses"]>>;

/** Hash the pinned route and the real process metadata. Remote paths stay on the remote host. */
export function remoteTerminalRevision(
  salt: string, list: RemoteProcessList, process: HcListedProcess, worktree: HerdrChatRemoteWorktree,
  directory: string | null,
) {
  if (!process.terminal.id.startsWith(worktree.machine + "/") || process.identity?.cwd !== worktree.remoteRoot) return undefined;
  const routes = list.machines.filter(route => route.name === worktree.machine);
  if (routes.length !== 1 || routes[0]!.state !== "connected" || routes[0]!.id !== worktree.machineId) return undefined;
  if (!directory) return undefined;
  return herdrProcessRevision(salt, list.generation, process, JSON.stringify([directory, worktree]));
}

const AttachedProcess = z.object({
  address: z.string(),
  pid: z.int().positive(),
  created_ms: z.int().nonnegative(),
  cwd: z.string(),
});

export function acceptRemoteAttachment(selected: HcListedProcess) {
  return (value: unknown) => {
    const result = AttachedProcess.safeParse(value);
    const identity = selected.identity;
    return Boolean(result.success && identity && result.data.address === selected.terminal.id
      && result.data.pid === identity.pid && result.data.created_ms === identity.created_ms
      && result.data.cwd === identity.cwd);
  };
}
