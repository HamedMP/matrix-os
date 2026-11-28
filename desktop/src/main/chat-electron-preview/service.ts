import { createHash } from "node:crypto";
import type { ChatElectronPreviewReply, ChatElectronPreviewTarget } from "../../shared/chat-electron-preview-ipc";
import type { MacActionPairing, MacActionPairingLease } from "../desktop-pairing/action";
import type { BeginMacActivity, MacActivityHandle, MacActivityPhase } from "../mac-activity/activity";
import type { ChatElectronPreviewBackgroundBinding, ChatElectronPreviewRequest } from "./transport";

type BackgroundPreview = ChatElectronPreviewBackgroundBinding & { pairing?: MacActionPairingLease };

interface PreviewResult {
  png: Buffer;
  testSummary: string;
}

interface Dependencies {
  enabled: boolean;
  acquireActionPairing?: MacActionPairing;
  read(target: ChatElectronPreviewTarget, background?: ChatElectronPreviewBackgroundBinding, signal?: AbortSignal): Promise<ChatElectronPreviewRequest | null>;
  isCurrent(request: ChatElectronPreviewRequest): boolean;
  wasHandled(key: string): Promise<boolean>;
  claim(key: string): Promise<boolean>;
  approve(request: ChatElectronPreviewRequest, signal: AbortSignal): Promise<boolean>;
  execute(request: ChatElectronPreviewRequest, signal: AbortSignal): Promise<PreviewResult>;
  returnResult(request: ChatElectronPreviewRequest, result: PreviewResult | { error: "build-failed" }, signal: AbortSignal): Promise<void>;
  beginActivity?: BeginMacActivity;
  reportError?(error: unknown): void;
}

function canceledPhase(signal: AbortSignal): MacActivityPhase {
  if (signal.reason === "stopped") return "stopped";
  if (signal.reason === "expired" || signal.reason?.name === "TimeoutError") return "expired";
  return "revoked";
}

function matchesApproval(approved: ChatElectronPreviewRequest, candidate: ChatElectronPreviewRequest): boolean {
  return approved.scopeKey === candidate.scopeKey && approved.chatId === candidate.chatId
    && approved.runId === candidate.runId && approved.projectId === candidate.projectId
    && approved.worktreeId === candidate.worktreeId && approved.expiresAt === candidate.expiresAt
    && approved.baseSha === candidate.baseSha && approved.sourceSha256 === candidate.sourceSha256
    && approved.label === candidate.label && approved.operation === candidate.operation
    && approved.backgroundTargetId === candidate.backgroundTargetId;
}

export function createChatElectronPreviewService(deps: Dependencies) {
  let active: { operation: AbortController; result: Promise<ChatElectronPreviewReply> } | null = null;

  async function runPreview(
    target: ChatElectronPreviewTarget, background: BackgroundPreview | undefined,
    operation: AbortController, signal: AbortSignal,
  ): Promise<ChatElectronPreviewReply> {
    const read = () => deps.read(target, background ? { ...background, signal } : undefined, signal);
    let activity: MacActivityHandle | undefined;
    let pairing: MacActionPairingLease | null | undefined;
    let completion: MacActivityPhase = "failed";
    let approvalSignal = signal;

    async function pairingIsCurrent(boundarySignal: AbortSignal): Promise<boolean> {
      if (boundarySignal.aborted || (pairing && !await pairing.check(boundarySignal))) return false;
      // A freshly paired device cannot inherit permission from an older background grant.
      if (background?.pairing && !await background.pairing.check(boundarySignal)) return false;
      return !boundarySignal.aborted;
    }

    try {
      const request = await read();
      if (!request || !deps.isCurrent(request) || signal.aborted) return { status: "unavailable" };
      const key = createHash("sha256").update(JSON.stringify([request.scopeKey, request.chatId, request.runId])).digest("hex");
      if (await deps.wasHandled(key)) return { status: "already-handled" };
      const remaining = request.expiresAt - Date.now();
      if (remaining <= 0 || signal.aborted || !deps.isCurrent(request)) return { status: "unavailable" };
      approvalSignal = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
      activity = deps.beginActivity?.("preview", request.worktreeId);
      activity?.update("awaiting-approval");
      const approved = await deps.approve(request, approvalSignal);
      completion = "revoked";
      if (approvalSignal.aborted || !deps.isCurrent(request)) return { status: "unavailable" };
      if (approved && deps.acquireActionPairing) {
        pairing = await deps.acquireActionPairing(operation, approvalSignal);
        if (!pairing || approvalSignal.aborted || !deps.isCurrent(request)) return { status: "unavailable" };
      }
      if (approved && background?.pairing && !await background.pairing.check(approvalSignal)) {
        return { status: "unavailable" };
      }
      if (approvalSignal.aborted || !deps.isCurrent(request)) return { status: "unavailable" };
      if (!await deps.claim(key)) return { status: "already-handled" };
      if (!approved) {
        completion = "declined";
        return { status: "declined" };
      }
      // The sheet may have been open while the agent edited, switched or
      // deleted the worktree. Keep the one-time claim and revalidate the bytes
      // bound to the approved request before starting any local work.
      const current = await read();
      if (!current || approvalSignal.aborted || !deps.isCurrent(request)
        || !deps.isCurrent(current) || !matchesApproval(request, current)) return { status: "unavailable" };
      if (!await pairingIsCurrent(approvalSignal) || approvalSignal.aborted || !deps.isCurrent(current)) return { status: "unavailable" };

      let result: Awaited<ReturnType<Dependencies["execute"]>>;
      // The request deadline governs approval and revalidation. The active
      // operation signal remains attached to execution and delivery.
      approvalSignal = signal;
      activity?.update("running");
      completion = "failed";
      try {
        result = await deps.execute(current, signal);
      } catch (error: unknown) {
        if (signal.aborted || !deps.isCurrent(current)) {
          completion = "revoked";
          return { status: "unavailable" };
        }
        deps.reportError?.(error);
        if (!await pairingIsCurrent(signal) || signal.aborted || !deps.isCurrent(current)) {
          completion = "revoked";
          return { status: "unavailable" };
        }
        activity?.update("returning");
        await deps.returnResult(current, { error: "build-failed" }, signal);
        return { status: "failed" };
      }
      if (!await pairingIsCurrent(signal) || signal.aborted || !deps.isCurrent(current)) {
        completion = "revoked";
        return { status: "unavailable" };
      }
      activity?.update("returning");
      await deps.returnResult(current, result, signal);
      completion = "returned";
      return { status: "returned" };
    } catch (error: unknown) {
      if (approvalSignal.aborted) return { status: "unavailable" };
      completion = "failed";
      deps.reportError?.(error);
      return { status: "failed" };
    } finally {
      pairing?.close();
      activity?.finish(completion !== "returned" && approvalSignal.aborted ? canceledPhase(approvalSignal) : completion);
    }
  }

  async function run(target: ChatElectronPreviewTarget, background?: BackgroundPreview): Promise<ChatElectronPreviewReply> {
    if (!deps.enabled || background?.signal.aborted) return { status: "unavailable" };
    if (active) return { status: "busy" };
    const operation = new AbortController();
    const signal = background ? AbortSignal.any([operation.signal, background.signal]) : operation.signal;
    const result = runPreview(target, background, operation, signal).finally(() => { active = null; });
    active = { operation, result };
    return result;
  }

  async function cancel(reason: "stopped" | "revoked" = "revoked"): Promise<void> {
    const current = active;
    current?.operation.abort(reason);
    try {
      await current?.result;
    } catch (error: unknown) {
      deps.reportError?.(error);
    }
  }

  return { available: deps.enabled, run, cancel };
}
