import {
  ManagedTerminalRuntimeSchema,
  ManagedTerminalTargetRequestSchema,
  MAX_MANAGED_TERMINAL_BODY_BYTES,
  MAX_MANAGED_TERMINAL_RESPONSE_BYTES,
  MAX_MANAGED_TERMINAL_WIRE_BYTES,
  type ManagedTerminalAction,
} from "@matrix-os/contracts/managed-terminal-control";
import {
  createManagedTerminalReplyHeaders,
  createManagedTerminalVerifier,
  MANAGED_TERMINAL_NONCE_HEADER,
  MANAGED_TERMINAL_TIMESTAMP_HEADER,
  openManagedTerminalPayload,
  sealManagedTerminalPayload,
} from "@matrix-os/contracts/managed-terminal-proof";
import type { TerminalRef } from "@matrix-os/contracts";
import type { HerdrSessionList } from "@matrix-os/contracts/herdr-terminals";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { TerminalInputActivity } from "../terminal-agent/input-activity.js";
import { TerminalAgentVerbError, type TerminalReadResult } from "../terminal-agent/verbs.js";
import type { createWorktreeManager } from "../worktree-manager.js";
import type { HerdrAdapter } from "./adapter.js";
import { createManagedTerminalRootResolver } from "./managed-terminal-worktree.js";
import { isHerdrPreviewRuntime, privatePreviewHerdrOwner } from "./private-preview.js";

const MAX_ACTIVE_REQUESTS = 8;

function readTargetConfig(env: NodeJS.ProcessEnv) {
  const ownerId = env.MATRIX_CLERK_USER_ID;
  const token = env.MATRIX_SYNC_RUNTIME_TOKEN;
  if (env.MATRIX_MANAGED_TERMINAL_CONTROL_ENABLED !== "1" || env.MATRIX_SELF_HOSTED === "1"
    || !ownerId || !token || !/^[a-f0-9]{64}$/.test(token)
    || (env.MATRIX_USER_ID !== undefined && env.MATRIX_USER_ID !== ownerId)
    || (isHerdrPreviewRuntime(env) && privatePreviewHerdrOwner(env) !== ownerId)) return null;
  const identity = ManagedTerminalRuntimeSchema.safeParse({
    machineId: env.MATRIX_MACHINE_ID, runtimeSlot: env.MATRIX_RUNTIME_SLOT, ownerId,
  });
  return identity.success ? { identity: identity.data, token } : null;
}

function boundedSessionList(list: HerdrSessionList): HerdrSessionList {
  const sessions: HerdrSessionList["sessions"] = [];
  const summary = { ...list, sessions };
  let used = Buffer.byteLength(JSON.stringify(summary));
  for (const session of list.sessions) {
    used += Buffer.byteLength(JSON.stringify(session)) + 1;
    if (used > MAX_MANAGED_TERMINAL_RESPONSE_BYTES) break;
    sessions.push(session);
  }
  return summary;
}

function recentText(text: string, limit: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  let start = bytes.length - limit;
  while ((bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

function boundedRead(read: TerminalReadResult) {
  // Quote/control escaping can expand UTF-8. Measure the wire bytes as well as the retained text.
  for (let limit = 16 * 1024; limit > 1; limit /= 2) {
    const screen = recentText(read.screen, limit);
    const history = recentText(read.history, limit);
    const result = screen === read.screen && history === read.history ? read : {
      ...read, screen, history, lines: history ? history.split("\n").length : 0, truncated: true,
    };
    if (Buffer.byteLength(JSON.stringify({ result })) <= MAX_MANAGED_TERMINAL_RESPONSE_BYTES) return result;
  }
  return { screen: "", history: "", lines: 0, truncated: true };
}

type ManagedTargetAdapter = Pick<HerdrAdapter, "listForManagedChatControl" | "bindManagedChatTerminal">;
type BoundTerminal = NonNullable<Awaited<ReturnType<ManagedTargetAdapter["bindManagedChatTerminal"]>>>;
async function act(terminal: BoundTerminal, ref: TerminalRef, action: ManagedTerminalAction) {
  switch (action.action) {
    case "list":
      await terminal.check();
      return { terminals: [ref] };
    case "read": return boundedRead(await terminal.read(action.lines));
    case "send": return terminal.send(action.text);
    case "interrupt": return terminal.interrupt();
  }
}

function signedReply(token: string, request: Request, payload: object, status = 200) {
  const body = sealManagedTerminalPayload(token, "target-response", JSON.stringify(payload));
  const issuedAt = Number(request.headers.get(MANAGED_TERMINAL_TIMESTAMP_HEADER));
  const nonce = request.headers.get(MANAGED_TERMINAL_NONCE_HEADER)!;
  return new Response(body, {
    status, headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...createManagedTerminalReplyHeaders(token, body, status, issuedAt, nonce),
    },
  });
}

/** Fixed Platform ingress. The existing Gateway bearer and source HMAC cannot act as a target proof. */
export function createManagedTerminalTargetRoutes(options: {
  adapter: ManagedTargetAdapter | null;
  inputActivity: TerminalInputActivity;
  homePath: string;
  worktrees: Pick<ReturnType<typeof createWorktreeManager>, "getWorktree">;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}) {
  const app = new Hono();
  const config = readTargetConfig(options.env ?? process.env);
  const verify = createManagedTerminalVerifier({ direction: "target", now: options.now });
  const resolveRoot = config && createManagedTerminalRootResolver({
    homePath: options.homePath, ownerId: config.identity.ownerId, worktrees: options.worktrees,
  });
  let active = 0;

  app.post("/", bodyLimit({ maxSize: MAX_MANAGED_TERMINAL_WIRE_BYTES }), async c => {
    c.header("Cache-Control", "no-store");
    if (!config || !resolveRoot || !options.adapter) return c.json({ error: "terminal_unavailable" }, 404);
    if (new URL(c.req.url).search || c.req.header("content-type")?.split(";")[0] !== "application/json") {
      return c.json({ error: "invalid_request" }, 400);
    }
    const raw = await c.req.text();
    const proofDeadline = verify(c.req.raw, config.token, raw);
    if (!proofDeadline) return c.json({ error: "unauthorized" }, 401);
    const json = openManagedTerminalPayload(config.token, "target", raw);
    if (!json || Buffer.byteLength(json) > MAX_MANAGED_TERMINAL_BODY_BYTES) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const parsed = ManagedTerminalTargetRequestSchema.safeParse(parsePayload(json));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const { source, target, request } = parsed.data;
    const identity = config.identity;
    if (source.ownerId !== identity.ownerId || target.ownerId !== identity.ownerId
      || target.machineId !== identity.machineId || target.runtimeSlot !== identity.runtimeSlot
      || request.targetMachineId !== identity.machineId || source.machineId === target.machineId) {
      return c.json({ error: "forbidden" }, 403);
    }
    const signal = AbortSignal.any([proofDeadline, c.req.raw.signal]);
    if (signal.aborted) return c.json({ error: "terminal_unavailable" }, 409);
    if (active >= MAX_ACTIVE_REQUESTS) return c.json({ error: "terminal_unavailable" }, 503);
    active += 1;
    let terminal: BoundTerminal | null = null;
    try {
      if (request.kind === "terminals") {
        const list = await options.adapter.listForManagedChatControl(resolveRoot);
        if (signal.aborted) return c.json({ error: "terminal_unavailable" }, 409);
        return signedReply(config.token, c.req.raw, boundedSessionList(list));
      }
      terminal = await options.adapter.bindManagedChatTerminal(request.ref, {
        revision: request.revision, signal, inputActivity: options.inputActivity,
      }, resolveRoot);
      if (!terminal || signal.aborted) return c.json({ error: "terminal_unavailable" }, 409);
      const result = await act(terminal, request.ref, request.action);
      if (signal.aborted) return c.json({ error: "terminal_unavailable" }, 409);
      if (request.action.action === "send" || request.action.action === "interrupt") {
        console.info("[terminal-control] Managed operation", {
          sourceMachine: source.machineId, targetMachine: target.machineId,
          run: request.runId, terminal: request.ref.tabId, action: request.action.action,
        });
      }
      return signedReply(config.token, c.req.raw, { result });
    } catch (error: unknown) {
      if (error instanceof TerminalAgentVerbError && error.code === "blocked") {
        return signedReply(config.token, c.req.raw, { error: "user_input_required" }, 409);
      }
      console.warn("[terminal-control] Managed target unavailable", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "terminal_unavailable" }, 409);
    } finally {
      terminal?.close();
      active -= 1;
    }
  });
  return app;
}

function parsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}
