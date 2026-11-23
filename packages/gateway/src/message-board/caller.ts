import type { Context } from "hono";
import type { BoardActor } from "@matrix-os/contracts/message-board";
import { MATRIX_MCP_RUN_CONTEXT_KEY, type MatrixMcpRunContext } from "../chat/matrix-mcp-launch.js";
import { requireRequestPrincipal } from "../request-principal.js";
import { boardFail } from "./errors.js";
import type { BoardCaller } from "./service.js";

export const BOARD_PERMISSIONS = ["read", "post", "react", "label", "manage"] as const;
export type BoardPermission = (typeof BOARD_PERMISSIONS)[number];

/** What an agent session may do unless its launch narrows it further (spec 2700 section 5). */
export const DEFAULT_AGENT_BOARD_CAN: readonly BoardPermission[] = ["read", "post", "react", "label"];

/** `x-matrix-terminal-caller: <zellij session>:<pane id>`, sent by `matrix board` inside a Matrix terminal. */
export const TERMINAL_CALLER_HEADER = "x-matrix-terminal-caller";
const TERMINAL_CALLER = /^(matrix-(?:w-|rt_)[0-9a-f]{32}):([0-9]{1,9})$/;
const SAFE_REF_PART = /^[A-Za-z0-9_-]{1,64}$/;

export interface TerminalCallerRef {
  workspaceId: string;
  tabId: string;
  /** The tab's agent labels; a watcher-started session carries `board.watcher` and `board.depth`. */
  labels?: Record<string, string>;
}

export interface BoardCallerOptions {
  ownerName: string;
  /** Maps a terminal pane to its canonical terminal tab (spec 2692 agents). */
  resolveTerminalCaller?: (caller: { sessionName: string; paneId: string }) => Promise<TerminalCallerRef | undefined>;
}

/**
 * Who is calling the board. Identity always comes from the authenticated
 * request, never from the body:
 * - a scoped Chat Run capability acts as `agent:run_<runId>`;
 * - an owner request that declares a Matrix terminal pane acts as that
 *   terminal's agent (declaring a pane can only narrow access);
 * - otherwise the owner acts as `user:<id>` with full access.
 * Agents get the default `can` set: no grants, watchers, schedules or boards.
 */
export async function resolveBoardCaller(c: Context, options: BoardCallerOptions): Promise<BoardCaller> {
  const principal = requireRequestPrincipal(c);
  const ownerId = principal.userId;
  const run = c.get(MATRIX_MCP_RUN_CONTEXT_KEY as never) as MatrixMcpRunContext | undefined;
  if (run?.runId) {
    const runId = run.runId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    if (!runId) boardFail("forbidden");
    return agentCaller(ownerId, { id: `agent:run_${runId}`, kind: "agent", name: `chat run ${runId.slice(-8)}` });
  }
  const declared = c.req.header(TERMINAL_CALLER_HEADER);
  if (declared !== undefined) {
    const match = TERMINAL_CALLER.exec(declared);
    if (!match) boardFail("invalid_input");
    const [, sessionName, paneId] = match;
    const ref = await options.resolveTerminalCaller?.({ sessionName: sessionName!, paneId: paneId! });
    if (ref && SAFE_REF_PART.test(ref.workspaceId) && SAFE_REF_PART.test(ref.tabId)) {
      const caller = agentCaller(ownerId, { id: `agent:${ref.workspaceId}.${ref.tabId}`, kind: "agent", name: `terminal ${ref.tabId.slice(-8)}` });
      const watcher = ref.labels?.["board.watcher"];
      const depth = Number(ref.labels?.["board.depth"]);
      return watcher && /^[a-z][a-z0-9-]{0,47}$/.test(watcher) && Number.isInteger(depth) && depth > 0
        ? { ...caller, origin: { watcher, depth: Math.min(depth, 99) } }
        : caller;
    }
    // An unregistered pane still acts as an agent, never as the owner.
    return agentCaller(ownerId, { id: `agent:pane.${sessionName!.slice(-12)}.${paneId}`, kind: "agent", name: `terminal pane ${paneId}` });
  }
  return { ownerId, actor: { id: `user:${ownerId}`, kind: "user", name: options.ownerName } };
}

function agentCaller(ownerId: string, actor: BoardActor): BoardCaller {
  return { ownerId, actor, can: DEFAULT_AGENT_BOARD_CAN };
}

/** The permission a board route needs; `manage` routes are owner-only. */
export function permissionForRoute(method: string, path: string): BoardPermission {
  // Agents may schedule their own follow-ups; boards (creating), grants and watchers are owner-only.
  if (/\/(?:grants|watchers)(?:\/|$)/.test(path)) return "manage";
  if (method === "GET" || method === "HEAD") return "read";
  if (/\/threads\/[^/]+\/read$/.test(path)) return "read";
  if (/\/reactions$/.test(path)) return "react";
  if (/\/labels$/.test(path)) return "label";
  if (/\/boards(?:\/|$)/.test(path)) return "manage";
  return "post";
}

export function requireBoardPermission(caller: BoardCaller, permission: BoardPermission): void {
  if (permission === "manage" && (caller.actor.kind !== "user" || (caller.principal && caller.principal !== caller.ownerId))) boardFail("forbidden");
  if (caller.can && !caller.can.includes(permission)) boardFail("forbidden");
}
