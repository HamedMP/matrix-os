import { CanonicalSetChatPermissionModeRequestSchema, type CanonicalSetChatPermissionModeRequest,
  type CanonicalSetChatPermissionModeResponse, type CanonicalChatRunActivity } from "@matrix-os/contracts";
import type { ChatRepository } from "./repository.js";
import type { ChatOwner } from "./records.js";
import type { CanonicalChatProviderAdapter } from "./provider-adapter.js";
import { permissionModeActivityId } from "./permission-mode-repository.js";
import { CanonicalChatOrchestrationError, canonicalChatSafeError } from "./orchestration-errors.js";

const unavailable = () => new CanonicalChatOrchestrationError(canonicalChatSafeError("capability_mismatch", "This Run cannot change permission mode."), 409);
export async function setCanonicalPermissionMode(options: {
  repository: Pick<ChatRepository, "getPermissionModeContext" | "appendRunActivities">;
  active?: { owner: ChatOwner; chatId: string; sharedScopeId?: string; adapter: CanonicalChatProviderAdapter; controller: AbortController };
  now?: () => Date;
}, owner: ChatOwner, chatId: string, runId: string, inputValue: CanonicalSetChatPermissionModeRequest,
provenance?: { permissionModeProof?: string }): Promise<CanonicalSetChatPermissionModeResponse> {
  const input = CanonicalSetChatPermissionModeRequestSchema.parse(inputValue);
  if (owner.type !== "personal" || !provenance?.permissionModeProof) throw unavailable();
  let readTimer: ReturnType<typeof setTimeout> | undefined;
  const context = await Promise.race([options.repository.getPermissionModeContext(owner, chatId, runId, input.clientRequestId),
    new Promise<never>((_resolve, reject) => { readTimer = setTimeout(() => reject(unavailable()), 3_000); readTimer.unref?.(); }),
  ]).finally(() => { if (readTimer) clearTimeout(readTimer); });
  if (!context || context.shared || context.run.context?.agent || context.run.interactionMode !== "default"
    || (!["supervised", "full_access"].includes(context.run.permissionMode) || !context.run.capabilitySnapshot.permissionModes.includes(input.permissionMode))) throw unavailable();
  if (context.unconfirmed) throw unavailable();
  if (context.previous) {
    if (context.previous.permissionMode !== input.permissionMode || context.run.permissionMode !== input.permissionMode) throw unavailable();
    return { chatId, runId, permissionMode: input.permissionMode, submission: "already_applied" };
  }
  if (context.attempted) throw unavailable();
  const active = options.active;
  if (!active || active.chatId !== chatId || active.owner.type !== owner.type || active.owner.ownerId !== owner.ownerId
    || active.sharedScopeId || active.controller.signal.aborted || !active.adapter.setPermissionMode
    || !["accepted", "running", "waiting_for_approval", "waiting_for_input"].includes(context.run.status)) throw unavailable();
  const appendPhase = async (phase: "pending" | "applied" | "confirmed") => {
    const activity: CanonicalChatRunActivity = { type: "run.permission_mode", ...input, phase,
      id: permissionModeActivityId(runId, input.clientRequestId, phase), chatId, runId,
      occurredAt: (options.now?.() ?? new Date()).toISOString() };
    await options.repository.appendRunActivities(owner, chatId, runId, [activity]);
  };
  try {
    await active.adapter.setPermissionMode({ ...input, owner, chatId, runId, permissionModeProof: provenance.permissionModeProof,
      async begin() {
        if (active.controller.signal.aborted) throw unavailable();
        await appendPhase("pending");
      },
      async commit() {
        if (active.controller.signal.aborted) throw unavailable();
        await appendPhase("applied");
      },
    });
  } catch (error: unknown) {
    console.warn("[chat/permission] Change unavailable", error instanceof Error ? error.name : "UnknownError");
    // Native control code distinguishes rejected proofs from partial changes; it
    // aborts/revokes partial changes itself. Never replay a failed native control.
    throw new CanonicalChatOrchestrationError(canonicalChatSafeError("run_unavailable", "Could not change permission mode. Try again.", true, ["retry"]), 503);
  }
  // Native authority and pending-tool release have fully succeeded. Only this
  // receipt promotes durable/public authority. A lost DB ACK is ambiguous success;
  // keep any confirmed receipt recoverable, but close uncertain live authority.
  let receiptTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([appendPhase("confirmed"), new Promise<never>((_resolve, reject) => {
      receiptTimer = setTimeout(() => reject(unavailable()), 5_000); receiptTimer.unref?.();
    })]);
  } catch (error: unknown) {
    console.warn("[chat/permission] Confirmation unavailable", error instanceof Error ? error.name : "UnknownError");
    // A rejected write will never produce a late receipt. Abort this exact run
    // before returning so neither tools nor steering can retain uncertain grants.
    active.controller.abort();
    throw new CanonicalChatOrchestrationError(canonicalChatSafeError("run_unavailable", "Permission change was not confirmed. Start a new message.", false, []), 503);
  } finally { if (receiptTimer) clearTimeout(receiptTimer); }
  return { chatId, runId, permissionMode: input.permissionMode, submission: "accepted" };
}
