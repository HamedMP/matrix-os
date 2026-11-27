import { setTimeout as delay } from "node:timers/promises";
import type { ChatElectronPreviewReply, ChatElectronPreviewTarget } from "../../shared/chat-electron-preview-ipc";
import type { MacActionPairing, MacActionPairingLease } from "../desktop-pairing/action";
import type { BeginMacActivity, MacActivityHandle, MacActivityPhase } from "../mac-activity/activity";
import { ChatElectronPreviewTransportInterruptedError, type ChatElectronPreviewBackgroundBinding,
  type ChatElectronPreviewRequest } from "./transport";
import { previewRequestKey } from "./claims";

type BackgroundPreview = ChatElectronPreviewBackgroundBinding & { pairing?: MacActionPairingLease };
const DELIVERY_RETRY_MS = 500;

interface PreviewResult {
  png: Buffer;
  testSummary: string;
}

interface ForegroundApproval {
  signal: AbortSignal;
  acquire(request: ChatElectronPreviewRequest, operation: AbortController, signal: AbortSignal):
    Promise<MacActionPairingLease | null>;
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
    && approved.requestKind === candidate.requestKind
    && approved.backgroundTargetId === candidate.backgroundTargetId;
}

export function createChatElectronPreviewService(deps: Dependencies) {
  let active: { operation: AbortController; result: Promise<ChatElectronPreviewReply> } | null = null;

  async function runPreview(
    target: ChatElectronPreviewTarget, background: BackgroundPreview | undefined,
    operation: AbortController, signal: AbortSignal, foreground?: ForegroundApproval,
  ): Promise<ChatElectronPreviewReply> {
    const read = () => deps.read(target, background ? { ...background, signal } : undefined, signal);
    let activity: MacActivityHandle | undefined;
    let pairing: MacActionPairingLease | null | undefined;
    let completion: MacActivityPhase = "failed";
    let approvalSignal = signal;

    async function pairingIsCurrent(boundarySignal: AbortSignal, retryBadGateway?: () => boolean): Promise<boolean> {
      if (boundarySignal.aborted || (pairing && !await pairing.check(boundarySignal, retryBadGateway))) return false;
      // A freshly paired device cannot inherit permission from an older background grant.
      if (background?.pairing && !await background.pairing.check(boundarySignal)) return false;
      return !boundarySignal.aborted;
    }

    async function deliver(current: ChatElectronPreviewRequest, result: PreviewResult | { error: "build-failed" }) {
      let pairingRetryAvailable = true;
      const retryBadGateway = current.requestKind === "verification" ? () => {
        if (!pairingRetryAvailable) return false;
        pairingRetryAvailable = false;
        return true;
      } : undefined;
      for (let attempt = 0; ; attempt++) {
        if (!await pairingIsCurrent(signal, retryBadGateway) || signal.aborted || !deps.isCurrent(current)) return false;
        if (attempt === 0) activity?.update("returning");
        try {
          // Re-check the exact Chat and source before writing and reconcile a receipt
          // that may already have been accepted. Do not repeat the local build.
          await deps.returnResult(current, result, signal);
          return true;
        } catch (error: unknown) {
          if (attempt !== 0 || current.requestKind !== "verification"
            || !(error instanceof ChatElectronPreviewTransportInterruptedError)) throw error;
          await delay(DELIVERY_RETRY_MS, undefined, { signal });
        }
      }
    }

    try {
      const request = await read();
      if (!request || !deps.isCurrent(request) || signal.aborted) return { status: "unavailable" };
      if (request.requestKind !== target.requestKind) return { status: "unavailable" };
      if (request.requestKind === "verification" && !deps.acquireActionPairing) return { status: "unavailable" };
      const key = previewRequestKey(request);
      if (await deps.wasHandled(key)) return { status: "already-handled" };
      const remaining = request.expiresAt - Date.now();
      if (remaining <= 0 || signal.aborted || !deps.isCurrent(request)) return { status: "unavailable" };
      approvalSignal = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
      activity = deps.beginActivity?.("preview", request.worktreeId);
      completion = "revoked";
      let approved: boolean;
      if (foreground) {
        pairing = await foreground.acquire(request, operation, approvalSignal);
        if (!pairing || approvalSignal.aborted || !deps.isCurrent(request)) return { status: "unavailable" };
        approved = true;
      } else {
        activity?.update("awaiting-approval");
        approved = await deps.approve(request, approvalSignal);
        if (approvalSignal.aborted || !deps.isCurrent(request)) return { status: "unavailable" };
        if (approved && deps.acquireActionPairing) {
          pairing = await deps.acquireActionPairing(operation, approvalSignal);
          if (!pairing || approvalSignal.aborted || !deps.isCurrent(request)) return { status: "unavailable" };
        }
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
        if (!await deliver(current, { error: "build-failed" })) {
          completion = "revoked";
          return { status: "unavailable" };
        }
        return { status: "failed" };
      }
      if (!await deliver(current, result)) {
        completion = "revoked";
        return { status: "unavailable" };
      }
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

  async function run(
    target: ChatElectronPreviewTarget, background?: BackgroundPreview, foreground?: ForegroundApproval,
  ): Promise<ChatElectronPreviewReply> {
    if (!deps.enabled || background?.signal.aborted || foreground?.signal.aborted) return { status: "unavailable" };
    if (active) return { status: "busy" };
    const operation = new AbortController();
    const boundSignal = background?.signal ?? foreground?.signal;
    const signal = boundSignal ? AbortSignal.any([operation.signal, boundSignal]) : operation.signal;
    const result = runPreview(target, background, operation, signal, foreground).finally(() => { active = null; });
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
