import { createHash } from "node:crypto";
import type { ChatElectronPreviewReply, ChatElectronPreviewTarget } from "../../shared/chat-electron-preview-ipc";
import type { ChatElectronPreviewBackgroundBinding, ChatElectronPreviewRequest } from "./transport";

interface PreviewResult {
  png: Buffer;
  testSummary: string;
}

interface Dependencies {
  enabled: boolean;
  read(target: ChatElectronPreviewTarget, background?: ChatElectronPreviewBackgroundBinding): Promise<ChatElectronPreviewRequest | null>;
  isCurrent(request: ChatElectronPreviewRequest): boolean;
  wasHandled(key: string): Promise<boolean>;
  claim(key: string): Promise<boolean>;
  approve(request: ChatElectronPreviewRequest, signal: AbortSignal): Promise<boolean>;
  execute(request: ChatElectronPreviewRequest, signal: AbortSignal): Promise<PreviewResult>;
  returnResult(request: ChatElectronPreviewRequest, result: PreviewResult | { error: "build-failed" }, signal: AbortSignal): Promise<void>;
  reportError?(error: unknown): void;
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
  let active: AbortController | null = null;

  async function run(target: ChatElectronPreviewTarget, background?: ChatElectronPreviewBackgroundBinding): Promise<ChatElectronPreviewReply> {
    if (!deps.enabled || background?.signal.aborted) return { status: "unavailable" };
    if (active) return { status: "busy" };
    const operation = new AbortController();
    active = operation;
    const signal = background ? AbortSignal.any([operation.signal, background.signal]) : operation.signal;
    const read = () => background ? deps.read(target, { ...background, signal }) : deps.read(target);
    try {
      const request = await read();
      if (!request || !deps.isCurrent(request) || signal.aborted) return { status: "unavailable" };
      const key = createHash("sha256").update(JSON.stringify([request.scopeKey, request.chatId, request.runId])).digest("hex");
      if (await deps.wasHandled(key)) return { status: "already-handled" };
      const remaining = request.expiresAt - Date.now();
      if (remaining <= 0 || signal.aborted || !deps.isCurrent(request)) return { status: "unavailable" };
      const approvalSignal = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
      const approved = await deps.approve(request, approvalSignal);
      if (approvalSignal.aborted || !deps.isCurrent(request)) return { status: "unavailable" };
      if (!await deps.claim(key)) return { status: "already-handled" };
      if (!approved) return { status: "declined" };
      // The sheet may have been open while the agent edited, switched or
      // deleted the worktree. Keep the one-time claim and revalidate the bytes
      // bound to the approved request before starting any local work.
      const current = await read();
      if (!current || approvalSignal.aborted || !deps.isCurrent(request)
        || !deps.isCurrent(current) || !matchesApproval(request, current)) return { status: "unavailable" };

      let result: Awaited<ReturnType<Dependencies["execute"]>>;
      try {
        result = await deps.execute(current, signal);
      } catch (error: unknown) {
        if (signal.aborted || !deps.isCurrent(current)) return { status: "unavailable" };
        deps.reportError?.(error);
        await deps.returnResult(current, { error: "build-failed" }, signal);
        return { status: "failed" };
      }
      if (signal.aborted || !deps.isCurrent(current)) return { status: "unavailable" };
      await deps.returnResult(current, result, signal);
      return { status: "returned" };
    } catch (error: unknown) {
      if (signal.aborted) return { status: "unavailable" };
      deps.reportError?.(error);
      return { status: "failed" };
    } finally {
      active = null;
    }
  }

  return { available: deps.enabled, run, cancel: () => active?.abort() };
}
