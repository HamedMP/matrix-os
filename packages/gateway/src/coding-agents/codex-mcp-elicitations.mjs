import { createHash } from "node:crypto";
import { z } from "zod/v4";

const RequestId = z.union([z.string().min(1).max(128), z.number().int().safe()]);
const Reference = z.string().min(1).max(512);
const SensitiveMessage = /[\u0000-\u001f\u007f]|(?:api[_-]?key|authorization|cookie|credential|password|secret|token)\s*(?:=|:|\s)/i;
const Request = z.object({
  id: RequestId,
  method: z.literal("mcpServer/elicitation/request"),
  params: z.object({
    threadId: Reference,
    turnId: Reference.nullable().optional(),
    serverName: Reference,
    mode: z.string().max(80),
    message: z.string().max(2400),
    requestedSchema: z.unknown().optional(),
  }).passthrough(),
}).passthrough();
// Codex 0.153.4 emits this empty form for an MCP tool-use confirmation.
// Forms requiring values and URL authentication need a dedicated UI, not an
// empty "accept" response or a silently dropped server request.
const Confirmation = z.object({
  type: z.literal("object"),
  properties: z.object({}).strict(),
  required: z.array(z.never()).optional(),
}).strict();

export function rejectCodexServerRequest(raw, send, code = -32601) {
  if (!raw || typeof raw.method !== "string" || !RequestId.safeParse(raw.id).success) return false;
  send({ id: raw.id, error: { code, message: "This request is unavailable." } });
  return true;
}

export function createCodexMcpElicitations({ send, persist, safeText, now = Date.now }) {
  // Owned by this runner; bounded admission, expiry sweep and turn-end drain.
  const pending = new Map();
  const cancel = entry => send({ id: entry.nativeRequestId, result: { action: "cancel", content: null } });
  async function expire(approvalId, entry) {
    pending.delete(approvalId); // Fence concurrent and late decisions before any await.
    try {
      await persist({ type: "matrix.codex.approval.resolved", approvalId, decision: "cancel" });
    } finally {
      try { cancel(entry); } catch (_error) { process.stderr.write("Integration cancellation could not be delivered.\n"); }
    }
  }
  return {
    get size() { return pending.size; },
    async handle(raw, threadId) {
      const parsed = Request.safeParse(raw);
      if (!parsed.success) return false;
      const request = parsed.data;
      if (request.params.threadId !== threadId) return rejectCodexServerRequest(raw, send, -32000);
      if (request.params.mode !== "form" || !Confirmation.safeParse(request.params.requestedSchema).success) {
        cancel({ nativeRequestId: request.id });
        process.stderr.write("Unsupported integration confirmation was cancelled.\n");
        return true;
      }
      const identity = createHash("sha256").update(JSON.stringify([
        request.method, request.id, threadId, request.params.turnId, request.params.serverName,
      ])).digest("hex").slice(0, 32);
      const approvalId = `appr_codex_${identity}`;
      if (pending.has(approvalId)) return true;
      if (pending.size >= 20) { cancel({ nativeRequestId: request.id }); return true; }
      pending.set(approvalId, { nativeRequestId: request.id, expiresAt: now() + 5 * 60_000 });
      await persist({
        type: "matrix.codex.approval.requested", approvalId,
        correlationId: `corr_codex_${identity}`, title: "Use integration",
        safeDescription: safeText(SensitiveMessage.test(request.params.message) ? "" : request.params.message,
          "The coding agent wants to use an integration.", 600, 2400),
        actionKind: "provider", risk: "high", allowedDecisions: ["approve", "decline", "cancel"],
      });
      return true;
    },
    async decide(approvalId, decision) {
      const entry = pending.get(approvalId);
      if (!entry || !["approve", "decline", "cancel"].includes(decision)) return false;
      if (entry.expiresAt <= now()) { await expire(approvalId, entry); return false; }
      send({ id: entry.nativeRequestId, result: {
        action: decision === "approve" ? "accept" : decision,
        content: decision === "approve" ? {} : null,
      } });
      pending.delete(approvalId);
      return true;
    },
    async sweep() {
      for (const [id, entry] of pending) {
        if (entry.expiresAt > now()) continue;
        await expire(id, entry);
      }
    },
    async drain() {
      const entries = [...pending.entries()];
      pending.clear();
      for (const [id, entry] of entries) {
        await expire(id, entry);
      }
    },
  };
}
