import { discoverChatTerminals, HerdrDiscoveryActionSchema } from "./herdr-discovery.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { desktopLinkDevicePrefix } from "@matrix-os/contracts/desktop-link";
import { isHerdrTerminalRef } from "@matrix-os/contracts/herdr-terminals";
import { isManagedTerminalRef, ManagedTerminalActionSchema } from "@matrix-os/contracts/managed-terminal-control";
import type { DesktopLinkRegistry } from "../desktop-link/registry.js";
import type { HerdrAdapter } from "../herdr/adapter.js";
import type { TerminalInputActivity } from "../terminal-agent/input-activity.js";
import { TerminalAgentVerbError } from "../terminal-agent/verbs.js";
import { MATRIX_MCP_RUN_CONTEXT_KEY, type MatrixMcpRunContext } from "./matrix-mcp-launch.js";
import type { ManagedTerminalBroker } from "./managed-terminal-source.js";

export function createHerdrChatTerminalRoute(
  adapter: Pick<HerdrAdapter, "bindChatTerminal"> & Partial<Pick<HerdrAdapter, "discoverTerminals">> | null, inputActivity: TerminalInputActivity,
  desktops?: DesktopLinkRegistry | null, managed?: ManagedTerminalBroker | null,
) {
  const app = new Hono();
  // A revocable run grant owns its single binding; simultaneous tool calls share the admission.
  const bindings = new WeakMap<AbortSignal, ReturnType<HerdrAdapter["bindChatTerminal"]>>();
  app.post("/", bodyLimit({ maxSize: 36 * 1024 }), async c => {
    c.header("Cache-Control", "no-store");
    const run = c.get(MATRIX_MCP_RUN_CONTEXT_KEY as never) as MatrixMcpRunContext | undefined;
    const target = run?.herdr;
    const discovery = run?.scope === "chat_herdr_discovery";
    if (!discovery && (run?.scope !== "chat_herdr" || !target || target.signal.aborted)) return c.json({ error: "forbidden" }, 403);
    if (!discovery && !adapter && !desktops && !managed) return c.json({ error: "terminal_unavailable" }, 503);
    if (new URL(c.req.url).search || c.req.header("content-type")?.split(";")[0] !== "application/json") {
      return c.json({ error: "invalid_request" }, 400);
    }
    try {
      const body = await c.req.json();
      if (discovery) {
        if (body?.action !== "discover") return c.json({ error: "forbidden" }, 403);
        const parsed = HerdrDiscoveryActionSchema.safeParse(body);
        if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
        const signal = run.herdrDiscoverySignal;
        if (!signal || signal.aborted) return c.json({ error: "forbidden" }, 403);
        const source = adapter?.discoverTerminals ? { discoverTerminals: adapter.discoverTerminals } : null;
        const result = await discoverChatTerminals(source, parsed.data, desktops,
          managed?.ownerId === run.actorId ? { broker: managed, signal } : undefined);
        if (signal.aborted) return c.json({ error: "forbidden" }, 403);
        return c.json(result);
      }
      if (!target || !run) return c.json({ error: "forbidden" }, 403);
      const parsed = ManagedTerminalActionSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
      const action = parsed.data;
      if (isManagedTerminalRef(target.ref)) {
        if (!managed || managed.ownerId !== run.actorId) return c.json({ error: "forbidden" }, 403);
        const result = await managed.run(target, run.runId, action, target.signal);
        if (target.signal.aborted) return c.json({ error: "forbidden" }, 403);
        return c.json({ runId: run.runId, ref: target.ref, result });
      }
      let binding = bindings.get(target.signal);
      if (!binding) {
        const selection = { signal: target.signal, inputActivity, revision: target.revision, worktreeId: target.worktreeId };
        binding = (async () => {
          if (isHerdrTerminalRef(target.ref)) return adapter?.bindChatTerminal(target.ref, target.executionRoot, selection) ?? null;
          const prefix = desktopLinkDevicePrefix(target.ref.workspaceId);
          const deviceId = prefix && desktops?.deviceByPrefix(prefix);
          if (!desktops || !deviceId) return null;
          const desktop = await desktops.chatLease(deviceId);
          if (!desktop || target.signal.aborted) return null;
          return desktops.adapter(deviceId)?.bindChatTerminal(target.ref, target.executionRoot, { ...selection, desktop }) ?? null;
        })();
        bindings.set(target.signal, binding);
      }
      const terminal = await binding;
      if (!terminal || target.signal.aborted) return c.json({ error: "terminal_unavailable" }, 409);
      let result: unknown;
      switch (action.action) {
        case "read": result = await terminal.read(action.lines); break;
        case "send": result = await terminal.send(action.text); break;
        case "interrupt": result = await terminal.interrupt(); break;
        case "list":
          // Confirm this incarnation is still live before returning the selected ref.
          await terminal.check();
          result = { terminals: [target.ref] }; break;
      }
      if (target.signal.aborted) return c.json({ error: "forbidden" }, 403);
      return c.json({ runId: run.runId, ref: target.ref, result });
    } catch (error: unknown) {
      if (target?.signal.aborted || run?.herdrDiscoverySignal?.aborted) return c.json({ error: "forbidden" }, 403);
      if (error instanceof SyntaxError || error instanceof z.ZodError) return c.json({ error: "invalid_request" }, 400);
      if (error instanceof TerminalAgentVerbError && error.code === "blocked") return c.json({ error: "user_input_required" }, 409);
      console.warn("[chat-herdr] Terminal operation unavailable", error instanceof Error ? error.name : "unknown_error");
      return c.json({ error: "terminal_unavailable" }, discovery ? 503 : 409);
    }
  });
  return app;
}
