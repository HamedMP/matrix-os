import type { BrowserWindow, IpcMain } from "electron";
import { dialog } from "electron";
import { isAbsolute, join } from "node:path";
import type { AuthService } from "../auth/auth-service";
import { CHAT_ELECTRON_PREVIEW_INVOKE } from "../../shared/chat-electron-preview-ipc";
import { createChatElectronPreviewClaims } from "./claims";
import { runChatElectronPreview } from "./executor";
import { createChatElectronPreviewService } from "./service";
import { createChatElectronPreviewTransport } from "./transport";

interface RegistrationOptions {
  auth: AuthService;
  allowed: boolean;
  checkout?: string;
  userData: string;
  electronPath: string;
  window(): BrowserWindow | null;
  isTrustedSender(event: unknown): boolean;
}

export function registerChatElectronPreview(ipc: Pick<IpcMain, "handle">, options: RegistrationOptions) {
  const { auth, checkout, userData, electronPath } = options;
  const transport = createChatElectronPreviewTransport(auth);
  const service = createChatElectronPreviewService({
    ...transport,
    ...createChatElectronPreviewClaims(join(userData, "chat-electron-preview-claims")),
    enabled: options.allowed && !!checkout && isAbsolute(checkout),
    async approve(request, signal) {
      const window = options.window();
      if (!window || window.isDestroyed()) return false;
      const answer = await dialog.showMessageBox(window, {
        type: "question",
        title: "Matrix",
        message: "Approve one Electron Desktop preview?",
        detail: [
          `Chat ${request.chatId}`,
          `Run ${request.runId}`,
          `Worktree ${request.worktreeId}`,
          `Commit ${request.baseSha}`,
          `Source SHA-256 ${request.sourceSha256}`,
          `New sign-in label: ${request.label}`,
        ].join("\n"),
        buttons: ["Cancel", "Approve Once"],
        defaultId: 0,
        cancelId: 0,
        signal,
      });
      return answer.response === 1;
    },
    execute(request, signal) {
      if (!checkout) throw new Error("preview source is unavailable");
      return runChatElectronPreview({ checkout, electronPath, baseSha: request.baseSha,
        sourceSha256: request.sourceSha256, label: request.label, signal });
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
  return service.cancel;
}
