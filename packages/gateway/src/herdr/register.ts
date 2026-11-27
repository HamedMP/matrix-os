// Gateway wiring for owner-hosted Herdr sessions (2701, ENG-495).
import type { Context, Hono } from "hono";
import type { TerminalRef } from "@matrix-os/contracts";
import type { UpgradeWebSocket } from "hono/ws";
import type { RequestPrincipal } from "../request-principal.js";
import type { TerminalInputActivity } from "../terminal-agent/input-activity.js";
import type { TerminalLiveOwnership } from "../terminal-live-ownership.js";
import { createHerdrAdapter, type HerdrAdapter } from "./adapter.js";
import { isHerdrPreviewRuntime, privatePreviewHerdrOwner } from "./private-preview.js";
import { createHerdrRoutes } from "./routes.js";
import { createHerdrCoreTransport } from "./transport.js";
import { registerHerdrTerminalWebSocket } from "./ws.js";

export function herdrTransportOptions(env: NodeJS.ProcessEnv, uid = process.getuid?.()) {
  if (!isHerdrPreviewRuntime(env)) {
    return env.MATRIX_HERDR?.trim().toLowerCase() === "on" ? { env } : null;
  }
  if (!privatePreviewHerdrOwner(env) || !uid) return null;
  // The managed terminal and Gateway run as the same matrix user. connect may
  // start the daemon, whose children must not inherit the Gateway's credentials.
  return {
    bin: "/opt/matrix/app/vendor/herdr/hc",
    env: {
      HOME: "/home/matrix/home", XDG_RUNTIME_DIR: `/run/user/${uid}`,
      PATH: "/opt/matrix/bin:/opt/matrix/runtime/node/bin:/usr/local/bin:/usr/bin:/bin",
      SHELL: "/bin/bash", LANG: "C.UTF-8",
    },
  };
}

/** The adapter over `herdr-core connect`, or null when Herdr sessions are off. Not started. */
export function createHerdrSessionsFromEnv(env: NodeJS.ProcessEnv = process.env): HerdrAdapter | null {
  const options = herdrTransportOptions(env);
  if (!options) return null;
  const transport = createHerdrCoreTransport(options);
  // A gateway that exits without shutting down still ends its `herdr-core connect` child.
  const onExit = () => transport.close();
  process.once("exit", onExit);
  return createHerdrAdapter({
    open: () => transport.open(),
    closeTransport: () => {
      process.off("exit", onExit);
      transport.close();
    },
  });
}

/** Whether a Matrix terminal ref names a Herdr terminal the owner's core lists now. */
export function herdrTerminalLookup(adapter: HerdrAdapter): { listed(ref: TerminalRef): Promise<boolean> } {
  return {
    async listed(ref) {
      const id = adapter.resolve(ref);
      if (id === undefined) return false;
      return (await adapter.list()).sessions.some((session) => session.id === id);
    },
  };
}

/** `/api/terminal/herdr` and `/ws/terminal/herdr`. Registered even when off, so clients see `available: false`. */
export function registerHerdrSessionRoutes(options: {
  app: Hono;
  upgradeWebSocket: UpgradeWebSocket;
  adapter: HerdrAdapter | null;
  getPrincipal(context: Context): RequestPrincipal;
  terminalOwnerIds: readonly string[];
  terminalLiveOwnership: TerminalLiveOwnership;
  terminalInputActivity?: TerminalInputActivity;
}) {
  options.app.route("/api/terminal/herdr", createHerdrRoutes(options));
  return registerHerdrTerminalWebSocket(options);
}
