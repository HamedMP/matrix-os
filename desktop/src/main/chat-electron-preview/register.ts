import type { BrowserWindow, IpcMain } from "electron";
import { dialog } from "electron";
import { isAbsolute, join } from "node:path";
import type { AuthService } from "../auth/auth-service";
import { CHAT_ELECTRON_PREVIEW_INVOKE } from "../../shared/chat-electron-preview-ipc";
import { createChatElectronPreviewClaims } from "./claims";
import { runChatElectronPreview } from "./executor";
import { createChatElectronPreviewService } from "./service";
import type { ChatElectronPreviewBackgroundBinding, createChatElectronPreviewTransport } from "./transport";

interface RegistrationOptions {
  auth: AuthService;
  transport: ReturnType<typeof createChatElectronPreviewTransport>;
  allowed: boolean;
  checkout?: string;
  userData: string;
  electronPath: string;
  window(): BrowserWindow | null;
  isTrustedSender(event: unknown): boolean;
}

export function registerChatElectronPreview(ipc: Pick<IpcMain, "handle">, options: RegistrationOptions) {
  const { auth, transport, checkout, userData, electronPath } = options;
  const service = createChatElectronPreviewService({
    ...transport,
    ...createChatElectronPreviewClaims(join(userData, "chat-electron-preview-claims")),
    enabled: options.allowed && !!checkout && isAbsolute(checkout),
    async approve(request, signal) {
      const window = options.window();
      const parent = window && !window.isDestroyed() ? window : null;
      if (!parent && !request.backgroundTargetId) return false;
      const prompt = {
        type: "question" as const,
        title: "Matrix",
        message: "Approve one Electron Desktop preview?",
        detail: [
          `Chat ${request.chatId}`,
          `Run ${request.runId}`,
          `Worktree ${request.worktreeId}`,
          `Commit ${request.baseSha}`,
          `Source SHA-256 ${request.sourceSha256}`,
          `New sign-in label: ${request.label}`,
          ...(request.operation ? ["Check that Sign in shows a recoverable connection error in the isolated preview."] : []),
        ].join("\n"),
        buttons: ["Cancel", "Approve Once"],
        defaultId: 0,
        cancelId: 0,
        signal,
      };
      const answer = parent ? await dialog.showMessageBox(parent, prompt) : await dialog.showMessageBox(prompt);
      return answer.response === 1;
    },
    execute(request, signal) {
      if (!checkout) throw new Error("preview source is unavailable");
      return runChatElectronPreview({ checkout, electronPath, baseSha: request.baseSha,
        sourceSha256: request.sourceSha256, label: request.label, operation: request.operation, signal });
    },
    reportError(error) {
      console.warn("[chat-electron-preview] operation failed", error instanceof Error ? error.name : "Error");
    },
  });

  const check = "chat:electron-preview-available";
  ipc.handle(check, (event, raw) => {
    if (!options.isTrustedSender(event)) throw new Error("invalid request");
    CHAT_ELECTRON_PREVIEW_INVOKE[check].request.parse(raw);
    return { available: service.available && auth.getStatus().signedIn };
  });
  const run = "chat:electron-preview-run";
  ipc.handle(run, async (event, raw) => {
    if (!options.isTrustedSender(event)) throw new Error("invalid request");
    const request = CHAT_ELECTRON_PREVIEW_INVOKE[run].request.safeParse(raw);
    if (!request.success) throw new Error("invalid request");
    return CHAT_ELECTRON_PREVIEW_INVOKE[run].response.parse(await service.run(request.data));
  });
  let lastHandled: { targetId: string; runId: string } | undefined;
  return {
    cancel: service.cancel,
    async tryBackgroundPreview(
      context: ChatElectronPreviewBackgroundBinding["context"],
      grant: ChatElectronPreviewBackgroundBinding["grant"],
      signal: AbortSignal,
      beginPreview: () => boolean,
    ) {
      if (!service.available || signal.aborted) return;
      const target = await transport.readBackgroundPreviewTarget(context, grant, signal);
      if (!target || (lastHandled?.targetId === grant.targetId && lastHandled.runId === target.runId)) return;
      if (!beginPreview()) return;
      const { status } = await service.run(target, { context, grant, signal });
      if ((status === "returned" || status === "declined" || status === "already-handled") && !signal.aborted) {
        lastHandled = { targetId: grant.targetId, runId: target.runId };
      }
      if (status !== "busy" && !signal.aborted) console.info("[chat-electron-preview]", "background request", status);
    },
  };
}
