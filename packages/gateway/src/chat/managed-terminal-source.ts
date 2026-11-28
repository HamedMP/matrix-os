import { Hono, type Context } from "hono";
import {
  HERDR_TERMINAL_WORKSPACE_ID, HerdrSessionListSchema,
} from "@matrix-os/contracts/herdr-terminals";
import {
  MANAGED_TERMINAL_BROKER_PATH, ManagedTerminalRuntimeSchema, ManagedTerminalBrokerRequestSchema,
  ManagedTerminalComputerListSchema, ManagedTerminalMachineIdSchema, ManagedTerminalActionResponseSchema,
  MAX_MANAGED_TERMINAL_RESPONSE_BYTES, type ManagedTerminalRuntime, type ManagedTerminalBrokerRequest,
  type ManagedTerminalAction,
} from "@matrix-os/contracts/managed-terminal-control";
import { createManagedTerminalHeaders, managedWorkspaceIdFor, readManagedTerminalResponse } from "@matrix-os/contracts/managed-terminal-proof";
import { hasVerifiedRuntimeBearer, type RequestPrincipal } from "../request-principal.js";
import { isHerdrPreviewRuntime, privatePreviewHerdrOwner } from "../herdr/private-preview.js";
import { herdrOwnerAccess } from "../herdr/routes.js";
import type { HerdrChatTarget } from "./herdr-chat-target.js";
import { TerminalAgentVerbError } from "../terminal-agent/verbs.js";

const TIMEOUT_MS = 11_000;
const MAX_CANARY_MS = 2 * 60 * 60_000;
const canaryOriginPattern = /^https:\/\/tc-[a-f0-9]{7,12}---matrix-platform-[a-z0-9-]+\.(?:[a-z0-9-]+\.)?run\.app$/;
const tokenPattern = /^[0-9a-f]{64}$/;

export function createManagedTerminalBroker(options: {
  origin: string; identity: ManagedTerminalRuntime; token: string; fetch?: typeof globalThis.fetch;
  canary?: { expiresAt: number; now: () => number };
}) {
  const { identity } = options;
  const url = new URL(MANAGED_TERMINAL_BROKER_PATH, options.origin);
  const fetcher = options.fetch ?? globalThis.fetch;
  async function request(action: ManagedTerminalBrokerRequest["request"], signal?: AbortSignal) {
    const { canary } = options;
    const remaining = canary ? canary.expiresAt - canary.now() : TIMEOUT_MS;
    if (remaining <= 0) throw new Error("Managed terminal candidate expired");
    const body = JSON.stringify(ManagedTerminalBrokerRequestSchema.parse({ source: identity, request: action }));
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(Math.min(TIMEOUT_MS, remaining));
    const response = await fetcher(url, {
      method: "POST", body, headers: createManagedTerminalHeaders(options.token, "source", body),
      signal: signal ? AbortSignal.any([deadline, signal]) : deadline, redirect: "error",
    });
    if (!response.ok) {
      if (response.status === 409) {
        const blocked = await readManagedTerminalResponse(response, 512);
        if (blocked && typeof blocked === "object" && "error" in blocked && blocked.error === "user_input_required") {
          throw new TerminalAgentVerbError("blocked");
        }
      } else {
        await response.body?.cancel();
      }
      throw new Error("Managed terminal unavailable");
    }
    const result = await readManagedTerminalResponse(response, MAX_MANAGED_TERMINAL_RESPONSE_BYTES);
    signal?.throwIfAborted();
    if (canary && canary.now() >= canary.expiresAt) throw new Error("Managed terminal candidate expired");
    return result;
  }
  async function computers(signal?: AbortSignal) {
    const list = ManagedTerminalComputerListSchema.parse(await request({ kind: "computers" }, signal));
    const workspaces = new Set<string>();
    const rows = list.computers.filter(row => row.machineId !== identity.machineId).map(row => {
      const workspaceId = managedWorkspaceIdFor(row.machineId);
      if (workspaces.has(workspaceId)) throw new Error("Ambiguous managed terminal workspace");
      workspaces.add(workspaceId);
      return { ...row, workspaceId };
    });
    return { computers: rows, partial: list.partial };
  }
  return {
    ownerId: identity.ownerId,
    runtimeSlot: identity.runtimeSlot,
    computers,
    async terminals(targetMachineId: string, signal?: AbortSignal) {
      const list = HerdrSessionListSchema.parse(await request({ kind: "terminals", targetMachineId }, signal));
      return { ...list, sessions: list.sessions.filter(row => row.revision && !row.machine) };
    },
    async run(target: HerdrChatTarget, runId: string, action: ManagedTerminalAction, signal: AbortSignal) {
      if (!target.authority) throw new Error("Managed terminal selection unavailable");
      const { computers: rows } = await computers(signal);
      const peer = rows.find(row => row.workspaceId === target.ref.workspaceId);
      if (!peer) throw new Error("Managed terminal unavailable");
      const { result } = ManagedTerminalActionResponseSchema.parse(await request({
        kind: "action", targetMachineId: peer.machineId, chatId: target.chatId, runId,
        worktreeId: target.worktreeId, ref: { workspaceId: HERDR_TERMINAL_WORKSPACE_ID, tabId: target.ref.tabId },
        revision: target.revision, action, authority: target.authority,
      }, signal));
      return action.action === "list" ? { terminals: [target.ref] } : result;
    },
  };
}
export type ManagedTerminalBroker = ReturnType<typeof createManagedTerminalBroker>;

export function managedTerminalBrokerFromEnv(
  env: NodeJS.ProcessEnv = process.env, options: { now?: () => number; fetch?: typeof globalThis.fetch } = {},
): ManagedTerminalBroker | null {
  if (env.MATRIX_MANAGED_TERMINAL_CONTROL_ENABLED !== "1" || env.MATRIX_SELF_HOSTED === "1") return null;
  const identity = ManagedTerminalRuntimeSchema.safeParse({
    ownerId: env.MATRIX_CLERK_USER_ID, machineId: env.MATRIX_MACHINE_ID, runtimeSlot: env.MATRIX_RUNTIME_SLOT,
  });
  const token = env.MATRIX_SYNC_RUNTIME_TOKEN;
  const platform = env.PLATFORM_INTERNAL_URL;
  if (!identity.success || !token || !tokenPattern.test(token) || !platform || !URL.canParse(platform)) return null;
  if (env.MATRIX_USER_ID && env.MATRIX_USER_ID !== identity.data.ownerId) return null;
  if (isHerdrPreviewRuntime(env) && privatePreviewHerdrOwner(env) !== identity.data.ownerId) return null;
  const origin = new URL(platform);
  if (origin.protocol !== "https:" || origin.origin !== platform) return null;
  const canaryOrigin = env.MATRIX_MANAGED_TERMINAL_CONTROL_CANARY_ORIGIN;
  const expiry = env.MATRIX_MANAGED_TERMINAL_CONTROL_CANARY_EXPIRES_AT;
  if (canaryOrigin === undefined && expiry === undefined) {
    return createManagedTerminalBroker({ origin: platform, identity: identity.data, token, fetch: options.fetch });
  }
  const now = options.now ?? Date.now;
  const expiresAt = Number(expiry);
  const remaining = expiresAt - now();
  if (identity.data.runtimeSlot !== "primary" || !canaryOrigin || !canaryOriginPattern.test(canaryOrigin) ||
      !/^\d{13}$/.test(expiry ?? "") || remaining <= 0 || remaining > MAX_CANARY_MS) return null;
  return createManagedTerminalBroker({
    origin: canaryOrigin, identity: identity.data, token, fetch: options.fetch, canary: { expiresAt, now },
  });
}

export function createManagedTerminalPickerRoutes(options: {
  broker: ManagedTerminalBroker | null;
  principal: (c: Context) => RequestPrincipal | null | undefined;
  ownerIds: readonly string[];
}) {
  const app = new Hono();
  app.get("/", async c => {
    c.header("Cache-Control", "no-store");
    const principal = options.principal(c);
    const broker = options.broker;
    if (!principal || herdrOwnerAccess(principal, options.ownerIds) !== "allowed" ||
        principal.source === "dev-default" || principal.userId !== broker?.ownerId ||
        (principal.source === "configured-container" && !hasVerifiedRuntimeBearer(c))) {
      return c.json({ error: "not_found" }, 404);
    }
    const query = new URL(c.req.url).searchParams;
    const machine = query.get("machine");
    const slot = query.get("runtime");
    if ((machine !== null && !ManagedTerminalMachineIdSchema.safeParse(machine).success) ||
        (slot !== null && slot !== broker.runtimeSlot) ||
        [...query.keys()].length !== Number(machine !== null) + Number(slot !== null)) {
      return c.json({ error: "invalid_request" }, 400);
    }
    try {
      return c.json(machine === null ? await broker.computers(c.req.raw.signal) : await broker.terminals(machine, c.req.raw.signal));
    } catch (error: unknown) {
      console.warn("[terminal-control] Managed picker unavailable", error instanceof Error ? error.name : "unknown_error");
      return c.json({ error: "terminal_unavailable" }, 503);
    }
  });
  return app;
}
