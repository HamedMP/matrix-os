import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { CanonicalChatRequestIdSchema } from "@matrix-os/contracts";
import type { CustomMcpApprovalClient } from "../chat/custom-mcp-approval-client.js";
import type { ManagedPiMcpClient } from "../chat/managed-pi-mcp-client.js";
import { HostedToolArguments, readHostedToolJson } from "./tool-bridge-json.js";

export const HOSTED_BOTS_MCP_DECISIONS_BASE = "/api/chats/hosted-bots";
const CHAT_ID = "hosted-bots";
const RUN_PREFIX = "hosted-bots-";
const MAX_REQUESTS = 4;
const MAX_CONTENT_BYTES = 24 * 1024;
const MAX_CATALOG_BYTES = 128 * 1024;
const DEADLINE_MS = 90_000;
const APPROVAL_PROOF_HEADER = "x-matrix-custom-mcp-approval-proof";
const ToolName = z.string().min(1).max(128).refine(value => value.trim() === value && !/[\x00-\x1f\x7f]/.test(value));
const Tool = z.object({
  name: ToolName, description: z.string().max(8192), inputSchema: HostedToolArguments,
  approval: z.enum(["allow", "always_ask"]),
});
const Server = z.object({ id: z.uuid(), name: z.string().trim().min(1).max(100), status: z.string().max(32),
  enabled: z.boolean(), tools: z.array(z.unknown()).max(100) });
const Call = z.strictObject({ serverId: z.uuid(), tool: ToolName, arguments: HostedToolArguments });
const Decision = z.strictObject({
  clientRequestId: CanonicalChatRequestIdSchema,
  decision: z.enum(["approve", "decline", "cancel"]),
});
const ApprovalProof = z.string().max(1500).regex(/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/);

export interface HostedBotsCustomMcpDependencies {
  client: ManagedPiMcpClient;
  approvals: Pick<CustomMcpApprovalClient, "registerRun" | "prepare" | "decide" | "revokeRun" | "verifyIntegrationDecision">;
}

type Approved = { receipt?: string };
type VisibleRequest = {
  id: string; runId: string; serverId: string; server: string; tool: string;
  params: Record<string, unknown>; expiresAt: number; status: "pending" | "reading";
};
type Request = {
  visible: VisibleRequest;
  platformApprovalId?: string;
  settle(value: Approved | null): void;
  cancel: AbortController;
};

function approvedServer(raw: unknown) {
  const row = Server.safeParse(raw);
  if (!row.success || !row.data.enabled || row.data.status !== "ready") return null;
  return { ...row.data, tools: row.data.tools.flatMap(rawTool => {
    const tool = Tool.safeParse(rawTool);
    return tool.success ? [tool.data] : [];
  }) };
}

export function createHostedBotsCustomMcpApproval(options: HostedBotsCustomMcpDependencies & {
  ownerId: string; isOwner: (c: Context) => boolean; timeoutMs?: number;
}) {
  const guestRoutes = new Hono();
  const ownerRoutes = new Hono();
  const decisionRoutes = new Hono();
  const lifetime = new AbortController();
  const requests = new Map<string, Request>();
  let activeCalls = 0;
  const timeout = options.timeoutMs ?? DEADLINE_MS;

  for (const route of [guestRoutes, ownerRoutes, decisionRoutes]) {
    route.use("*", async (c, next) => {
      c.header("cache-control", "no-store");
      c.header("x-content-type-options", "nosniff");
      if (route !== guestRoutes && !options.isOwner(c)) return c.json({ error: "forbidden" }, 403);
      if (lifetime.signal.aborted) return c.json({ error: "unavailable" }, 503);
      if (new URL(c.req.url).search) return c.json({ error: "invalid_request" }, 400);
      await next();
    });
    route.onError((error, c) => {
      if (error.name === "BodyLimitError") return c.json({ error: "too_large" }, 413);
      console.warn("[hosted-bots] Custom MCP request failed", error.name);
      return c.json({ error: "unavailable" }, 503);
    });
  }
  const cap = (maxSize: number) => bodyLimit({ maxSize, onError: c => c.json({ error: "too_large" }, 413) });

  guestRoutes.get("/catalog", async (c) => {
    const signal = AbortSignal.any([c.req.raw.signal, lifetime.signal]);
    const rows = z.array(z.unknown()).max(100).parse(await options.client.inventory(options.ownerId, signal));
    const servers = rows.flatMap((raw) => {
      const server = approvedServer(raw);
      return server?.tools.length ? [{ id: server.id, name: server.name, tools: server.tools }] : [];
    });
    const result = { servers };
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_CATALOG_BYTES) return c.json({ error: "unavailable" }, 503);
    return c.json(result);
  });

  ownerRoutes.get("/", c => c.json({
    requests: Array.from(requests.values(), ({ visible }) => visible)
      .filter(request => request.expiresAt > Date.now()),
  }));

  decisionRoutes.post("/runs/:runId/approvals/:id", cap(1024), async (c) => {
    const runId = c.req.param("runId");
    const id = z.uuid().safeParse(c.req.param("id"));
    const decision = await readHostedToolJson(c, Decision);
    if (!runId.startsWith(RUN_PREFIX) || !z.uuid().safeParse(runId.slice(RUN_PREFIX.length)).success || !id.success || !decision) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const request = requests.get(runId);
    if (!request || request.visible.id !== id.data || request.visible.expiresAt <= Date.now()) {
      return c.json({ error: "not_found" }, 404);
    }
    if (decision.decision === "cancel") {
      request.cancel.abort();
      return c.json({ ok: true }, 202);
    }
    if (request.visible.status !== "pending") return c.json({ error: "conflict" }, 409);
    const proof = ApprovalProof.safeParse(c.req.header(APPROVAL_PROOF_HEADER));
    if (!proof.success) return c.json({ error: "forbidden" }, 403);
    request.visible.status = "reading";
    try {
      const provenance = { chatId: CHAT_ID, clientRequestId: decision.clientRequestId, platformApprovalProof: proof.data };
      if (!request.platformApprovalId && !await options.approvals.verifyIntegrationDecision?.({
        ...provenance, runId, approvalId: id.data, decision: decision.decision,
      })) {
        if (!request.cancel.signal.aborted) request.visible.status = "pending";
        return c.json({ error: "forbidden" }, 403);
      }
      const outcome = request.platformApprovalId
        ? await options.approvals.decide(runId, request.platformApprovalId, decision.decision, provenance)
        : {};
      if (request.platformApprovalId && decision.decision === "approve" && !outcome.receipt) {
        request.settle(null);
        return c.json({ error: "forbidden" }, 403);
      }
      request.settle(decision.decision === "approve" ? outcome : null);
      return c.json({ ok: true }, 202);
    } catch (error: unknown) {
      console.warn("[hosted-bots] Custom MCP decision refused", error instanceof Error ? error.name : "UnknownError");
      if (!request.cancel.signal.aborted) request.visible.status = "pending";
      return c.json({ error: "unavailable" }, 503);
    }
  });

  guestRoutes.post("/call", cap(4096), async (c) => {
    const input = await readHostedToolJson(c, Call);
    if (!input) return c.json({ error: "invalid_request" }, 400);
    if (activeCalls >= MAX_REQUESTS) return c.json({ error: "limit" }, 429);
    const runId = RUN_PREFIX + randomUUID();
    const deadline = Date.now() + timeout;
    const cancel = new AbortController();
    const signal = AbortSignal.any([c.req.raw.signal, lifetime.signal, cancel.signal, AbortSignal.timeout(timeout)]);
    if (signal.aborted) return c.json({ error: "forbidden" }, 403);
    activeCalls++;
    let registered = false;
    try {
      const server = approvedServer(await options.client.describe(options.ownerId, input.serverId, signal));
      if (server?.id !== input.serverId || !server.tools.some(({ name }) => name === input.tool) || signal.aborted) {
        return c.json({ error: "forbidden" }, 403);
      }
      const { generation } = await options.approvals.registerRun(runId);
      registered = true;
      signal.throwIfAborted();
      const approval = await options.approvals.prepare(runId, {
        generation, nativeRequestId: randomUUID(), ...input,
      });
      const platformApprovalId = approval.kind === "pending" ? approval.approvalId : undefined;
      const expiresAt = Math.min(deadline, approval.kind === "pending" ? Date.parse(approval.expiresAt) : Infinity);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || signal.aborted) {
        return c.json({ error: "forbidden" }, 403);
      }
      // Even a stored Allow policy requires an owner decision here: this
      // reusable Unix socket can be reached by processes in the OSS workload.
      const wait = Promise.withResolvers<Approved | null>();
      const abort = () => wait.resolve(null);
      signal.addEventListener("abort", abort, { once: true });
      requests.set(runId, {
        visible: { runId, id: platformApprovalId ?? randomUUID(), serverId: server.id, server: server.name,
          tool: input.tool, params: input.arguments, expiresAt, status: "pending" },
        platformApprovalId, settle: wait.resolve, cancel,
      });
      let approved: Approved | null;
      try {
        if (signal.aborted) abort();
        approved = await wait.promise;
      } finally {
        signal.removeEventListener("abort", abort);
      }
      if (!approved || signal.aborted) return c.json({ error: "forbidden" }, 403);
      const data = await options.client.call(options.ownerId, {
        ...input, runId, ...(approved.receipt ? { approvalReceipt: approved.receipt } : {}),
      }, signal, () => {
        // The Platform's streaming reply ties the remote MCP request to cancellation.
      });
      if (signal.aborted) return c.json({ error: "forbidden" }, 403);
      const result = { data };
      if (data === undefined || Buffer.byteLength(JSON.stringify(result)) > MAX_CONTENT_BYTES) {
        return c.json({ error: "unavailable" }, 503);
      }
      return c.json(result);
    } catch (error: unknown) {
      if (signal.aborted) return c.json({ error: "forbidden" }, 403);
      throw error;
    } finally {
      requests.delete(runId);
      cancel.abort();
      if (registered) {
        try { await options.approvals.revokeRun(runId); }
        catch (error: unknown) {
          console.warn("[hosted-bots] Custom MCP lease cleanup failed", error instanceof Error ? error.name : "UnknownError");
        }
      }
      activeCalls--;
    }
  });

  return { guestRoutes, ownerRoutes, decisionRoutes, close: () => lifetime.abort() };
}
