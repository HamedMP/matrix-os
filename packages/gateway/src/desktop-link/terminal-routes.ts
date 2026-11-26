// Terminals on a linked desktop (spec 2716 layer 4): list, start, end, read and
// type, through the Herdr adapter that rides that desktop's link. Mounted inside
// the owner-only Desktop link API, so only the computer's owner reaches them.
import type { Context, Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { HerdrSessionIdSchema } from "@matrix-os/contracts/herdr-terminals";
import { DesktopLinkDeviceIdSchema, desktopLinkDevicePrefix, desktopLinkWorkspaceId } from "@matrix-os/contracts/desktop-link";
import { HcCallError } from "@matrix-os/herdr-core-client/client";
import { HerdrAdapterError, type HerdrAdapter } from "../herdr/adapter.js";
import { herdrTabId } from "../herdr/refs.js";
import { TERMINAL_KEYS_MAX, TerminalAgentVerbError, type TerminalAgentVerbs } from "../terminal-agent/verbs.js";
import { TERMINAL_WAIT_MAX_MS, TERMINAL_WAIT_OUTPUT_MAX_CHARS, TerminalWaitCapacityError, type TerminalWaiter } from "../terminal-agent/wait.js";
import { registerHerdrTerminalWebSocket } from "../herdr/ws.js";
import type { RequestPrincipal } from "../request-principal.js";
import type { TerminalInputActivity } from "../terminal-agent/input-activity.js";
import type { TerminalLiveOwnership } from "../terminal-live-ownership.js";
import type { DesktopLinkRegistry } from "./registry.js";
import { DesktopCaptureError } from "./link.js";

/**
 * Browser viewers of a desktop terminal: `?workspaceId=<the desktop's workspace>&tabId=`
 * or `&id=<terminal>`, frames as `/ws/terminal/tab`.
 */
export const DESKTOP_LINK_TERMINAL_WS_PATH = "/ws/desktop-link/terminal";

/**
 * The viewer socket for desktop terminals: 2701's Herdr viewer socket, with the
 * adapter chosen by the desktop workspace the viewer names and terminal ids scoped
 * to that desktop. Owner only, like every Herdr socket.
 */
export function registerDesktopLinkTerminalSocket(options: {
  app: Hono;
  upgradeWebSocket: UpgradeWebSocket;
  registry: DesktopLinkRegistry;
  getPrincipal(context: Context): RequestPrincipal;
  terminalOwnerIds: readonly string[];
  terminalLiveOwnership: TerminalLiveOwnership;
  terminalInputActivity?: TerminalInputActivity;
}) {
  return registerHerdrTerminalWebSocket({
    ...options,
    adapter: null,
    path: DESKTOP_LINK_TERMINAL_WS_PATH,
    workspace: (workspaceId) => {
      const prefix = desktopLinkDevicePrefix(workspaceId);
      const deviceId = prefix ? options.registry.deviceByPrefix(prefix) : null;
      const adapter = deviceId ? options.registry.adapter(deviceId) : null;
      return deviceId && adapter ? { workspaceId: desktopLinkWorkspaceId(deviceId), adapter, scope: `desktop:${deviceId}` } : null;
    },
  });
}

/** The fixed command lines the agent presets start, in the desktop user's login shell. */
export const DESKTOP_LINK_AGENT_LINES = {
  claude: "claude",
  codex: "codex --no-daemon",
  opencode: "opencode",
  pi: "pi",
} as const;

const MAX_SCREEN_LINES = 2_000;
const MAX_INPUT_CHARS = 64 * 1024;

const CreateSchema = z.strictObject({
  cols: z.number().int().min(20).max(500).default(120),
  rows: z.number().int().min(5).max(200).default(36),
  agent: z.enum(["claude", "codex", "opencode", "pi"]).optional(),
  argv: z.array(z.string().min(1).max(4 * 1024)).min(1).max(64).optional(),
  cwd: z.string().min(1).max(1024).refine((value) => !value.includes("\0")).optional(),
  // The desktop's own rule for names (and never one shaped like an address), so a bad name is a 400, not a refusal.
  name: z.string().regex(/^[a-z0-9_.-]{1,32}$/).refine((name) => !/^t[0-9]/.test(name)).optional(),
}).refine((body) => !(body.agent && body.argv), { message: "agent or argv, not both" });
const InputSchema = z.strictObject({ data: z.string().min(1).max(MAX_INPUT_CHARS) });
const LinesSchema = z.string().regex(/^\d{1,5}$/).transform(Number).pipe(z.number().int().min(0).max(MAX_SCREEN_LINES)).default(200);

const small = bodyLimit({ maxSize: 1024, onError: (c) => c.json({ error: "invalid_request" }, 413) });
const large = bodyLimit({ maxSize: 96 * 1024, onError: (c) => c.json({ error: "invalid_request" }, 413) });

async function parseJson<T>(c: Context, schema: z.ZodType<T>): Promise<T | undefined> {
  if (c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return undefined;
  try {
    const parsed = schema.safeParse(await c.req.json());
    return parsed.success ? parsed.data : undefined;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** The 2692 verbs and waits this layer uses on desktop terminals (keys, interrupt, wait). */
export type DesktopTerminalVerbs = Pick<TerminalAgentVerbs, "keys" | "interrupt">;
export type DesktopTerminalWaiter = Pick<TerminalWaiter, "wait">;

const KeysSchema = z.strictObject({ keys: z.array(z.string().min(1).max(16)).min(1).max(TERMINAL_KEYS_MAX) });
const InterruptSchema = z.strictObject({});
const WaitSchema = z.strictObject({
  output: z.string().min(1).max(TERMINAL_WAIT_OUTPUT_MAX_CHARS).optional(),
  seen: z.number().int().min(0).max(1_000_000).optional(),
  timeoutMs: z.number().int().min(0).max(TERMINAL_WAIT_MAX_MS).optional(),
});

export function addDesktopLinkTerminalRoutes(api: Hono, registry: DesktopLinkRegistry, options: {
  now?: () => number;
  log: (message: string) => void;
  verbs?: DesktopTerminalVerbs;
  waiter?: DesktopTerminalWaiter;
}): void {
  function linked(c: Context): { deviceId: string; adapter: HerdrAdapter } | Response {
    const device = DesktopLinkDeviceIdSchema.safeParse(c.req.param("deviceId"));
    if (!device.success) return c.json({ error: "invalid_request" }, 400);
    const adapter = registry.adapter(device.data);
    if (!adapter) return c.json({ error: "desktop_offline" }, 503);
    return { deviceId: device.data, adapter };
  }
  function terminalId(c: Context): string | null {
    const id = HerdrSessionIdSchema.safeParse(c.req.param("id"));
    return id.success ? id.data : null;
  }
  function failed(c: Context, error: unknown, what: string): Response {
    // The desktop's guard, or its owner, refused the call (spec 2716, D2).
    if (error instanceof HcCallError && error.kind === "denied") return c.json({ error: "denied" }, 403);
    if (error instanceof HerdrAdapterError) {
      if (error.code === "not_found") return c.json({ error: "not_found" }, 404);
      if (error.code === "capacity") return c.json({ error: "busy" }, 429);
      return c.json({ error: "desktop_offline" }, 503);
    }
    options.log(`${what} failed: ${error instanceof Error ? error.name : "UnknownError"}`);
    return c.json({ error: "desktop_offline" }, 503);
  }

  api.get("/machines/:deviceId/terminals", async (c) => {
    const target = linked(c);
    if (target instanceof Response) return target;
    try {
      const listed = await target.adapter.list();
      if (!listed.available) return c.json({ error: "desktop_offline" }, 503);
      // Refs for these terminals use the desktop's own workspace id, never Herdr's.
      return c.json({ deviceId: target.deviceId, workspaceId: desktopLinkWorkspaceId(target.deviceId), sessions: listed.sessions });
    } catch (error: unknown) { return failed(c, error, "listing"); }
  });

  api.post("/machines/:deviceId/terminals", large, async (c) => {
    const target = linked(c);
    if (target instanceof Response) return target;
    const body = await parseJson(c, CreateSchema);
    if (!body) return c.json({ error: "invalid_request" }, 400);
    if (!registry.allowRun(target.deviceId)) return c.json({ error: "busy" }, 429);
    try {
      const id = await target.adapter.create({ cols: body.cols, rows: body.rows }, {
        ...(body.agent ? { line: DESKTOP_LINK_AGENT_LINES[body.agent] } : {}),
        ...(body.argv ? { argv: body.argv } : {}),
        ...(body.cwd ? { cwd: body.cwd } : {}),
        ...(body.name ? { name: body.name } : {}),
      });
      if (!id) return c.json({ error: "busy" }, 429);
      // The ref every OS view opens it by, so a client can show it at once.
      return c.json({ deviceId: target.deviceId, id, workspaceId: desktopLinkWorkspaceId(target.deviceId), tabId: herdrTabId(id) }, 201);
    } catch (error: unknown) {
      // The desktop refused the folder or the program (its guard), or its core is gone.
      if (error instanceof HcCallError) return c.json({ error: "denied" }, 403);
      return failed(c, error, "starting a terminal");
    }
  });

  api.delete("/machines/:deviceId/terminals/:id", small, async (c) => {
    const target = linked(c);
    if (target instanceof Response) return target;
    const id = terminalId(c);
    if (!id) return c.json({ error: "invalid_request" }, 400);
    try {
      await target.adapter.kill(id);
      return c.json({ ok: true });
    } catch (error: unknown) { return failed(c, error, "ending a terminal"); }
  });

  api.get("/machines/:deviceId/terminals/:id/screen", async (c) => {
    const target = linked(c);
    if (target instanceof Response) return target;
    const id = terminalId(c);
    const lines = LinesSchema.safeParse(c.req.query("lines"));
    if (!id || !lines.success) return c.json({ error: "invalid_request" }, 400);
    try {
      return c.json(await target.adapter.captureScreen(id, lines.data));
    } catch (error: unknown) { return failed(c, error, "reading a terminal"); }
  });

  api.post("/machines/:deviceId/terminals/:id/input", large, async (c) => {
    const target = linked(c);
    if (target instanceof Response) return target;
    const id = terminalId(c);
    const body = await parseJson(c, InputSchema);
    if (!id || !body) return c.json({ error: "invalid_request" }, 400);
    try {
      await target.adapter.writeInput(id, body.data);
      return c.json({ ok: true });
    } catch (error: unknown) { return failed(c, error, "typing into a terminal"); }
  });

  /** A desktop terminal's ref in the 2692 pipeline, once the desktop is linked and the id is known. */
  function desktopRef(c: Context): { ref: { workspaceId: string; tabId: string } } | Response {
    const target = linked(c);
    if (target instanceof Response) return target;
    const id = terminalId(c);
    if (!id) return c.json({ error: "invalid_request" }, 400);
    return { ref: { workspaceId: desktopLinkWorkspaceId(target.deviceId), tabId: herdrTabId(id) } };
  }
  function verbFailed(c: Context, error: unknown, what: string): Response {
    if (error instanceof TerminalWaitCapacityError) return c.json({ error: "busy" }, 429);
    if (error instanceof TerminalAgentVerbError) {
      if (error.code === "blocked") return c.json({ error: "blocked" }, 409);
      if (error.code === "finished") return c.json({ error: "finished" }, 409);
      if (error.code === "invalid_request") return c.json({ error: "invalid_request" }, 400);
      return c.json({ error: "not_found" }, 404);
    }
    return failed(c, error, what);
  }

  /**
   * One screenshot of the desktop's screen, as JPEG. The desktop takes it only while
   * the person allows Screen Recording for Matrix OS there; until then this
   * answers 409 `screen_recording_not_allowed` and the person grants it once.
   */
  api.post("/machines/:deviceId/screenshot", small, async (c) => {
    const target = linked(c);
    if (target instanceof Response) return target;
    try {
      const image = await registry.capture(target.deviceId);
      return c.body(new Uint8Array(image), 200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store" });
    } catch (error: unknown) {
      if (error instanceof DesktopCaptureError) {
        if (error.code === "permission") return c.json({ error: "screen_recording_not_allowed" }, 409);
        if (error.code === "declined") return c.json({ error: "denied" }, 403);
        if (error.code === "unavailable") return c.json({ error: "screenshot_unavailable" }, 409);
        if (error.code === "busy") return c.json({ error: "busy" }, 429);
        if (error.code === "offline") return c.json({ error: "desktop_offline" }, 503);
        return c.json({ error: "screenshot_failed" }, 502);
      }
      return failed(c, error, "taking a screenshot");
    }
  });

  api.post("/machines/:deviceId/terminals/:id/keys", small, async (c) => {
    if (!options.verbs) return c.json({ error: "unavailable" }, 503);
    const target = desktopRef(c);
    if (target instanceof Response) return target;
    const body = await parseJson(c, KeysSchema);
    if (!body) return c.json({ error: "invalid_request" }, 400);
    try { return c.json(await options.verbs.keys(target.ref, body)); }
    catch (error: unknown) { return verbFailed(c, error, "pressing keys"); }
  });

  api.post("/machines/:deviceId/terminals/:id/interrupt", small, async (c) => {
    if (!options.verbs) return c.json({ error: "unavailable" }, 503);
    const target = desktopRef(c);
    if (target instanceof Response) return target;
    if (!(await parseJson(c, InterruptSchema))) return c.json({ error: "invalid_request" }, 400);
    try { return c.json(await options.verbs.interrupt(target.ref, { signal: c.req.raw.signal })); }
    catch (error: unknown) { return verbFailed(c, error, "interrupting"); }
  });

  api.post("/machines/:deviceId/terminals/:id/wait", small, async (c) => {
    if (!options.waiter) return c.json({ error: "unavailable" }, 503);
    const target = desktopRef(c);
    if (target instanceof Response) return target;
    const body = await parseJson(c, WaitSchema);
    if (!body) return c.json({ error: "invalid_request" }, 400);
    try { return c.json(await options.waiter.wait(target.ref, { ...body, signal: c.req.raw.signal })); }
    catch (error: unknown) { return verbFailed(c, error, "waiting"); }
  });
}
