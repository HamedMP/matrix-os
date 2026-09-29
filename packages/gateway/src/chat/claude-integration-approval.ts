import { randomUUID } from "node:crypto";
import type { CanonicalChatApprovalDecision } from "@matrix-os/contracts";
import type { CustomMcpApprovalClient } from "./custom-mcp-approval-client.js";
import type { MatrixMcpRunCapability } from "./matrix-mcp-launch.js";
import { integrationToolRequest, MATRIX_INTEGRATION_ACTION_TOOLS } from "./integration-tool-authority.js";
import { CanonicalProviderRunEventSchema, type CanonicalProviderRunEvent } from "./provider-adapter.js";
import { sanitizeAssistantText } from "./safe-activity-projection.js";

type Respond = (value: unknown) => Promise<void>;
interface Pending {
  nativeId: string; tool: string; input: Record<string, unknown>; respond: Respond;
  timer: ReturnType<typeof setTimeout>; deciding?: Promise<void>;
  resolved?: boolean; revokeGrant?: () => void;
}

export function createClaudeIntegrationApprovalControl(options: {
  runId: string; homePath: string; capability: MatrixMcpRunCapability;
  verify?: CustomMcpApprovalClient["verifyIntegrationDecision"];
  emit(event: CanonicalProviderRunEvent): void; onError(error: unknown): void;
}) {
  const pending = new Map<string, Pending>(); // max 16; resolved/closed/timed-out entries removed
  type Grant = NonNullable<ReturnType<NonNullable<MatrixMcpRunCapability["grantIntegrationTool"]>>>;
  const issued = new Map<string, { grant: Grant; revoke(): void }>(); // max 16, consumed/expired entries swept
  let closed = false;
  function sweepIssued() {
    for (const entry of issued.values()) if (!entry.grant.isLive()) entry.revoke();
  }
  function retainGrant(nativeId: string, grant: Grant): () => void {
    const timer = setTimeout(() => entry.revoke(), 90_000);
    timer.unref?.();
    const entry = { grant, revoke() {
      clearTimeout(timer);
      if (issued.get(nativeId) === entry) issued.delete(nativeId);
      grant.revoke();
    } };
    issued.set(nativeId, entry);
    return entry.revoke;
  }
  function forget(id: string, current: Pending): boolean {
    if (pending.get(id) !== current) return false;
    clearTimeout(current.timer);
    pending.delete(id);
    return true;
  }
  function resolved(id: string, decision: CanonicalChatApprovalDecision, current: Pending) {
    if (current.resolved) return;
    current.resolved = true;
    options.emit(CanonicalProviderRunEventSchema.parse({ type: "approval.resolved", approvalId: id, decision }));
  }
  function deny(respond: Respond) {
    return respond({ behavior: "deny", message: "Integration action approval is unavailable." });
  }
  function cancel(id: string, current: Pending) {
    if (!forget(id, current)) return;
    // A cancelled native write must not leave an executable action behind.
    current.revokeGrant?.();
    resolved(id, "cancel", current);
    void deny(current.respond).catch(options.onError);
  }
  return {
    has(id: string) { return pending.has(id); },
    onToolPermission(request: { nativeRequestId: string; toolName: string; input: Record<string, unknown> }, respond: Respond): boolean {
      if (!(MATRIX_INTEGRATION_ACTION_TOOLS as readonly string[]).includes(request.toolName)) return false;
      const action = integrationToolRequest(request.toolName, request.input);
      sweepIssued();
      const duplicate = issued.has(request.nativeRequestId)
        || [...pending.values()].some(value => value.nativeId === request.nativeRequestId);
      if (duplicate) return true;
      const description = JSON.stringify(request.input);
      if (closed || !action || !options.verify || !options.capability.grantIntegrationTool || pending.size >= 16 || description.length > 4000) {
        void deny(respond).catch(options.onError);
        return true;
      }
      const id = `integration_${randomUUID()}`;
      const current: Pending = { nativeId: request.nativeRequestId, tool: request.toolName,
        input: structuredClone(request.input), respond,
        timer: setTimeout(() => cancel(id, current), 5 * 60_000) };
      current.timer.unref?.();
      pending.set(id, current);
      options.emit(CanonicalProviderRunEventSchema.parse({ type: "approval.requested", approvalId: id,
        title: sanitizeAssistantText(action.title, { homePath: options.homePath }).slice(0, 160),
        safeDescription: sanitizeAssistantText(description, { homePath: options.homePath }),
        risk: "high", allowedDecisions: ["approve", "decline", "cancel"] }));
      return true;
    },
    onToolPermissionCancel(nativeId: string) {
      for (const [id, current] of pending) if (current.nativeId === nativeId) cancel(id, current);
      issued.get(nativeId)?.revoke();
    },
    async submit(id: string, decision: CanonicalChatApprovalDecision, provenance?: {
      chatId: string; clientRequestId: string; platformApprovalProof?: string;
    }) {
      const current = pending.get(id);
      if (!current || closed || decision === "approve_for_session") throw new Error("Integration approval unavailable");
      if (current.deciding) throw new Error("Integration approval already resolving");
      current.deciding = (async () => {
        let responseStarted = false;
        let responseWritten = false;
        try {
          if (!provenance?.platformApprovalProof || !options.verify || !await options.verify({
            runId: options.runId, approvalId: id, decision, chatId: provenance.chatId,
            clientRequestId: provenance.clientRequestId, platformApprovalProof: provenance.platformApprovalProof,
          })) throw new Error("Authenticated integration approval unavailable");
          if (closed || pending.get(id) !== current) throw new Error("Integration approval cancelled");
          let approvedInput = current.input;
          if (decision === "approve") {
            sweepIssued();
            if (issued.size >= 16) throw new Error("Integration authority unavailable");
            const grant = options.capability.grantIntegrationTool?.(current.tool, current.input);
            if (!grant) throw new Error("Integration authority unavailable");
            current.revokeGrant = retainGrant(current.nativeId, grant);
            approvedInput = { ...current.input, matrix_approval_receipt: grant.receipt };
          }
          responseStarted = true;
          await current.respond(decision === "approve" ? { behavior: "allow", updatedInput: approvedInput }
            : { behavior: "deny", message: "Integration action declined." });
          responseWritten = true;
          if (closed || pending.get(id) !== current) throw new Error("Integration approval cancelled");
          forget(id, current);
          resolved(id, decision, current);
        } catch (error: unknown) {
          const transportFailed = responseStarted && !responseWritten;
          if (transportFailed) {
            options.capability.revoke();
          }
          cancel(id, current);
          resolved(id, "cancel", current);
          if (transportFailed) options.onError(error);
          throw error;
        }
      })();
      await current.deciding;
    },
    close() {
      closed = true;
      for (const [id, current] of pending) cancel(id, current);
      for (const entry of issued.values()) entry.revoke();
      options.capability.revoke();
    },
  };
}
