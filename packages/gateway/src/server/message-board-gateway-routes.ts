/** Register the owner message board routes and event socket (spec 2700), or a 503 when the owner database is missing. */
import type { Context, Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { boardErrorBody } from "../message-board/errors.js";
import { BOARD_EVENTS_WS_PATH, registerBoardEventsWebSocket } from "../message-board/events-ws.js";
import { createMessageBoardRoutes } from "../message-board/routes.js";
import type { MessageBoardRuntime } from "../message-board/runtime.js";
import type { BoardCaller } from "../message-board/service.js";
import { resolveBoardCaller, type BoardCallerOptions } from "../message-board/caller.js";
import { requireRequestPrincipal } from "../request-principal.js";
import { createDedupingNotifier } from "../message-board/notifications.js";

export const MESSAGE_BOARD_API_PREFIX = "/api/board";

export interface MessageBoardGatewayRouteOptions {
  app: Hono;
  upgradeWebSocket?: UpgradeWebSocket;
  runtime: MessageBoardRuntime | null;
  /** Display name for the owner's own posts. */
  ownerName?: string;
  resolveTerminalCaller?: BoardCallerOptions["resolveTerminalCaller"];
}

/** The owner principal acting as `user:<id>` with full access. */
export function ownerBoardCaller(c: Context, ownerName: string): BoardCaller {
  const principal = requireRequestPrincipal(c);
  return { ownerId: principal.userId, actor: { id: `user:${principal.userId}`, kind: "user", name: ownerName } };
}

export function registerMessageBoardGatewayRoutes(options: MessageBoardGatewayRouteOptions): void {
  const { app, runtime } = options;
  if (!runtime) {
    // Missing owner database is misconfiguration, not missing data.
    app.all(`${MESSAGE_BOARD_API_PREFIX}/*`, (c) => c.json(boardErrorBody("unavailable"), 503));
    app.get(BOARD_EVENTS_WS_PATH, (c) => c.json(boardErrorBody("unavailable"), 503));
    return;
  }
  const ownerName = options.ownerName?.trim().slice(0, 64) || "Owner";
  const resolveCaller = (c: Context) => resolveBoardCaller(c, { ownerName, resolveTerminalCaller: options.resolveTerminalCaller });
  app.route(MESSAGE_BOARD_API_PREFIX, createMessageBoardRoutes({
    service: runtime.service, tasks: runtime.tasks, hub: runtime.hub, resolveCaller,
    automation: { watchers: runtime.watchers, schedules: runtime.schedules, grants: runtime.grants },
  }));
  if (options.upgradeWebSocket) {
    registerBoardEventsWebSocket({ app, upgradeWebSocket: options.upgradeWebSocket, hub: runtime.hub, service: runtime.service, resolveCaller });
  }
}

/** What a watcher can wake on this computer, and where board notifications go (spec 2700 sections 6 and 10). */
export function configureMessageBoardAutomation(runtime: MessageBoardRuntime | null, deps: {
  /** Spec 2692 terminal agents: start a template with a first task. */
  runTerminalAgent?: (input: { projectId?: string; name: string; cwd: string; template?: string; task?: string; labels?: Record<string, string> }) => Promise<unknown>;
  /** Lists terminal tabs, so a retried run reuses the tab an earlier attempt already started. */
  listTerminals?: () => Promise<unknown>;
  /** The owner's push channel. */
  push?: (reply: { channelId: "push"; chatId: string; ownerId: string; text: string }) => Promise<void>;
  ownerHandles?: readonly string[];
}): void {
  if (!runtime) return;
  const run = deps.runTerminalAgent;
  const push = deps.push;
  runtime.configureAutomation({
    actions: run ? {
      async start(input) {
        // The tab name carries the run's idempotency key: a retry after a lost outcome finds it and starts nothing.
        const name = `${input.name.slice(0, 40)} #${input.idempotencyKey.split(":").at(-1)}`.slice(0, 64);
        if (deps.listTerminals && await terminalNamed(deps.listTerminals, name)) return;
        await run({
          ...(input.projectId ? { projectId: input.projectId } : {}), name, cwd: "", template: input.template, task: input.task,
          labels: { "board.watcher": input.origin.watcher, "board.depth": String(input.origin.depth) },
        });
      },
    } : {},
    ...(push ? { notifier: createDedupingNotifier((notification) => push({
      channelId: "push", chatId: "message-board", ownerId: notification.ownerId, text: `${notification.title}: ${notification.body}`,
    })) } : {}),
    ownerHandles: deps.ownerHandles ?? [],
  });
}

export interface BoardTerminalAgents {
  agents: {
    resolveCaller(caller: { sessionName: string; paneId: string }): Promise<{ workspaceId: string; tabId: string } | undefined>;
    describe(ref: { workspaceId: string; tabId: string }): Promise<{ labels?: Record<string, string> } | undefined>;
  };
  kernelTools: {
    run(input: { projectId?: string; name: string; cwd: string; template?: string; task?: string; labels?: Record<string, string> }): Promise<unknown>;
    list(): Promise<unknown>;
  };
}

/** Resolves a declared pane to its tab and labels, so watcher-started sessions carry their depth. */
export function boardTerminalCaller(terminal: BoardTerminalAgents): NonNullable<BoardCallerOptions["resolveTerminalCaller"]> {
  return async (caller) => {
    const ref = await terminal.agents.resolveCaller(caller);
    if (!ref) return undefined;
    const record = await terminal.agents.describe(ref);
    return { ...ref, ...(record?.labels ? { labels: record.labels } : {}) };
  };
}

async function terminalNamed(list: () => Promise<unknown>, name: string): Promise<boolean> {
  const workspaces = await list();
  if (!Array.isArray(workspaces)) return false;
  return workspaces.some((workspace) => Array.isArray((workspace as { tabs?: unknown }).tabs)
    && ((workspace as { tabs: Array<{ name?: unknown }> }).tabs).some((tab) => tab.name === name));
}
