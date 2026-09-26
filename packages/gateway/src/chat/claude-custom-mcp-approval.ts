import { z } from "zod/v4";
import type { CanonicalChatApprovalDecision } from "@matrix-os/contracts";
import type { CanonicalProviderRunEvent } from "./provider-adapter.js";
import { CanonicalProviderRunEventSchema } from "./provider-adapter.js";
import type { CustomMcpApprovalClient } from "./custom-mcp-approval-client.js";

export const CALL_TOOL = "mcp__matrix-integrations__call_custom_mcp_tool";
const ToolInput = z.object({
  server_id: z.uuid(),
  tool: z.string().min(1).max(128),
  arguments: z.record(z.string(), z.unknown()).optional(),
}).strict();
type ToolInput = z.infer<typeof ToolInput>;
type Respond = (value: unknown) => Promise<void>;
interface Pending {
  nativeRequestId: string;
  input: ToolInput;
  respond: Respond;
  timer: ReturnType<typeof setTimeout>;
  deciding?: Promise<void>;
}

export function createClaudeCustomMcpApprovalControl(options: {
  runId: string;
  generation: number;
  client: CustomMcpApprovalClient;
  emit(event: CanonicalProviderRunEvent): void;
  onError(error: unknown): void;
}) {
  const pending = new Map<string, Pending>();
  const native = new Map<string, string>();
  const preparing = new Map<string, { cancelled: boolean }>();
  let closed = false;
  const deny = (respond: Respond) => respond({ behavior: "deny", message: "Custom MCP approval is unavailable." });

  function forget(approvalId: string, current: Pending): boolean {
    if (pending.get(approvalId) !== current) return false;
    clearTimeout(current.timer);
    pending.delete(approvalId);
    native.delete(current.nativeRequestId);
    return true;
  }

  async function cancel(approvalId: string, current: Pending): Promise<void> {
    if (!forget(approvalId, current)) return;
    try { await options.client.decide(options.runId, approvalId, "cancel"); }
    catch (error: unknown) { options.onError(error); }
    try { await deny(current.respond); }
    finally {
      options.emit(CanonicalProviderRunEventSchema.parse({
        type: "approval.resolved", approvalId, decision: "cancel",
      }));
    }
  }

  async function prepare(nativeRequestId: string, rawInput: Record<string, unknown>, respond: Respond,
    slot: { cancelled: boolean }): Promise<void> {
    try {
      const parsed = ToolInput.safeParse(rawInput);
      if (closed || slot.cancelled || !parsed.success) {
        await deny(respond);
        return;
      }
      const input = parsed.data;
      const description = `Server ${input.server_id}\nTool ${input.tool}\nArguments ${JSON.stringify(input.arguments ?? {})}`;
      if (description.length > 4_000) { await deny(respond); return; }
      const result = await options.client.prepare(options.runId, {
        generation: options.generation, nativeRequestId, serverId: input.server_id,
        tool: input.tool, arguments: input.arguments,
      });
      if (closed || slot.cancelled) {
        if (result.kind === "pending") await options.client.decide(options.runId, result.approvalId, "cancel");
        await deny(respond);
        return;
      }
      if (result.kind === "allow") {
        await respond({ behavior: "allow", updatedInput: input });
        return;
      }
      const approvalId = result.approvalId;
      const ttl = Math.max(1, Math.min(10 * 60_000, Date.parse(result.expiresAt) - Date.now()));
      const current: Pending = {
        nativeRequestId, input, respond,
        timer: setTimeout(() => { void cancel(approvalId, current).catch(options.onError); }, ttl),
      };
      current.timer.unref?.();
      pending.set(approvalId, current);
      native.set(nativeRequestId, approvalId);
      options.emit(CanonicalProviderRunEventSchema.parse({
        type: "approval.requested", approvalId, title: `Allow ${input.tool}?`,
        safeDescription: description, risk: "high", allowedDecisions: ["approve", "decline", "cancel"],
      }));
    } catch (error: unknown) {
      options.onError(error);
      await deny(respond);
    } finally {
      if (preparing.get(nativeRequestId) === slot) preparing.delete(nativeRequestId);
    }
  }

  return {
    onToolPermission(request: { nativeRequestId: string; toolName: string; input: Record<string, unknown> }, respond: Respond): boolean {
      if (request.toolName !== CALL_TOOL) return false;
      if (closed || preparing.has(request.nativeRequestId) || native.has(request.nativeRequestId)
        || preparing.size + pending.size >= 16) {
        void deny(respond).catch(options.onError);
        return true;
      }
      const slot = { cancelled: false };
      preparing.set(request.nativeRequestId, slot);
      void prepare(request.nativeRequestId, request.input, respond, slot).catch(options.onError);
      return true;
    },
    onToolPermissionCancel(nativeRequestId: string): void {
      const slot = preparing.get(nativeRequestId);
      if (slot) slot.cancelled = true;
      const approvalId = native.get(nativeRequestId);
      const current = approvalId ? pending.get(approvalId) : undefined;
      if (approvalId && current) void cancel(approvalId, current).catch(options.onError);
    },
    async submit(approvalId: string, decision: CanonicalChatApprovalDecision, provenance?: {
      chatId: string; clientRequestId: string; platformApprovalProof?: string;
    }): Promise<void> {
      if (closed || !["approve", "decline", "cancel"].includes(decision)) throw new Error("Approval unavailable");
      const current = pending.get(approvalId);
      if (!current || current.deciding) throw new Error("Approval unavailable");
      if (!provenance?.platformApprovalProof) {
        await cancel(approvalId, current);
        throw new Error("Authenticated approval proof unavailable");
      }
      current.deciding = (async () => {
        try {
          const result = await options.client.decide(options.runId, approvalId,
            decision as "approve" | "decline" | "cancel", {
              chatId: provenance.chatId, clientRequestId: provenance.clientRequestId,
              platformApprovalProof: provenance.platformApprovalProof!,
            });
          if (!forget(approvalId, current) || closed) return;
          if (decision === "approve" && result.receipt) {
            await current.respond({ behavior: "allow", updatedInput: {
              ...current.input, approval_receipt: result.receipt,
            } });
          } else if (decision === "approve") {
            await deny(current.respond);
            throw new Error("Approval receipt unavailable");
          } else {
            await deny(current.respond);
          }
          options.emit(CanonicalProviderRunEventSchema.parse({ type: "approval.resolved", approvalId, decision }));
        } catch (error: unknown) {
          if (pending.get(approvalId) === current) await cancel(approvalId, current);
          else options.emit(CanonicalProviderRunEventSchema.parse({ type: "approval.resolved", approvalId, decision: "cancel" }));
          throw error;
        }
      })();
      await current.deciding;
    },
    close(): void {
      closed = true;
      for (const slot of preparing.values()) slot.cancelled = true;
      for (const [approvalId, current] of pending) {
        forget(approvalId, current);
        void deny(current.respond).catch(options.onError);
        options.emit(CanonicalProviderRunEventSchema.parse({
          type: "approval.resolved", approvalId, decision: "cancel",
        }));
      }
    },
  };
}
