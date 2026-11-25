import { dialog, type BrowserWindow, type IpcMain, type OpenDialogOptions } from "electron";
import { isAbsolute, join } from "node:path";
import type { MacActionPairing, MacActionPairingLease } from "../desktop-pairing/action";
import type { AuthService } from "../auth/auth-service";
import { CHAT_ELECTRON_PREVIEW_INVOKE } from "../../shared/chat-electron-preview-ipc";
import type { BeginMacActivity } from "../mac-activity/activity";
import { showMacActivityDialog } from "../mac-activity/dialog";
import { createChatElectronPreviewClaims } from "./claims";
import { runChatElectronPreview } from "./executor";
import { createChatElectronPreviewService } from "./service";
import type { ChatElectronPreviewBackgroundBinding, ChatElectronPreviewRequest, createChatElectronPreviewTransport } from "./transport";
import { createMacVerificationSetup, resolveVerificationSource } from "./verification-setup";

interface RegistrationOptions {
  auth: AuthService;
  acquireActionPairing: MacActionPairing;
  transport: ReturnType<typeof createChatElectronPreviewTransport>;
  allowed: boolean;
  macVerificationAllowed?: boolean;
  checkout?: string;
  userData: string;
  electronPath: string;
  window(): BrowserWindow | null;
  isTrustedSender(event: unknown): boolean;
  beginActivity?: BeginMacActivity;
}

export function registerChatElectronPreview(ipc: Pick<IpcMain, "handle">, options: RegistrationOptions) {
  const { auth, transport, checkout, userData, electronPath } = options;
  const legacySource = options.allowed && checkout && isAbsolute(checkout) ? { checkout, electronPath } : null;
  // The legacy development environment is separate from a user-enabled
  // installed client's native settings.
  const setup = options.macVerificationAllowed ? createMacVerificationSetup({
    getStatus: () => auth.getStatus(),
    acquirePairing: options.acquireActionPairing,
    resolveSource: resolveVerificationSource,
    async pickDirectory() {
      const win = options.window();
      const request: OpenDialogOptions = { title: "Choose a trusted Matrix OS checkout", properties: ["openDirectory"] };
      const response = win && !win.isDestroyed()
        ? await dialog.showOpenDialog(win, request) : await dialog.showOpenDialog(request);
      return response.canceled ? null : response.filePaths[0] ?? null;
    },
    async prompt(prompt) {
      return (await showMacActivityDialog(options.window(), { ...prompt, title: "Matrix" })).response;
    },
    stop(reason) { void service.cancel(reason); },
  }) : null;
  function verificationAvailable() {
    return Boolean(setup?.enabled() || legacySource);
  }
  function resolveSource(request: ChatElectronPreviewRequest, signal: AbortSignal) {
    return request.requestKind === "verification" && setup?.enabled()
      ? setup.resolveActiveSource(signal) : legacySource;
  }
  // The service admits only one action at a time. Match the selected local
  // source against the one shown during approval after the cloud reread.
  let approvedSource: { checkout: string; electronPath: string; identity?: string } | null = null;
  const service = createChatElectronPreviewService({
    ...transport,
    beginActivity: options.beginActivity,
    acquireActionPairing: options.acquireActionPairing,
    ...createChatElectronPreviewClaims(join(userData, "chat-electron-preview-claims")),
    enabled: Boolean(legacySource || setup),
    async approve(request, signal) {
      approvedSource = null;
      const source = await resolveSource(request, signal);
      signal.throwIfAborted();
      if (!source) return false;
      if (request.requestKind === "verification" && !request.operation && !request.backgroundTargetId) {
        const fullAccess = await setup?.getFullAccessApproval(signal);
        signal.throwIfAborted();
        if (fullAccess) {
          approvedSource = source;
          return fullAccess;
        }
      }
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
          `Mac checkout ${source.checkout}`,
          `Commit ${request.baseSha}`,
          `Source SHA-256 ${request.sourceSha256}`,
          request.requestKind === "verification" ? `Sign-in label: ${request.label}` : `New sign-in label: ${request.label}`,
          ...(request.operation ? ["Check that Sign in shows a recoverable connection error in the isolated preview."] : []),
        ].join("\n"),
        buttons: ["Cancel", "Approve Once"],
        defaultId: 0,
        cancelId: 0,
        signal,
      };
      const answer = await showMacActivityDialog(parent, prompt);
      if (signal.aborted || answer.response !== 1) return false;
      approvedSource = source;
      return true;
    },
    async execute(request, signal) {
      const source = await resolveSource(request, signal);
      signal.throwIfAborted();
      const identity = source && "identity" in source ? source.identity : undefined;
      if (!source || source.checkout !== approvedSource?.checkout || source.electronPath !== approvedSource.electronPath
        || identity !== approvedSource.identity) throw new Error("preview source changed");
      approvedSource = null;
      return runChatElectronPreview({
        checkout: source.checkout, electronPath: source.electronPath, baseSha: request.baseSha,
        sourceSha256: request.sourceSha256, label: request.label, operation: request.operation,
        requestKind: request.requestKind, signal,
      });
    },
    reportError(error) {
      console.warn("[chat-electron-preview] operation failed", error instanceof Error ? error.name : "Error");
    },
  });

  const check = "chat:electron-preview-available";
  ipc.handle(check, (event, raw) => {
    if (!options.isTrustedSender(event)) throw new Error("invalid request");
    CHAT_ELECTRON_PREVIEW_INVOKE[check].request.parse(raw);
    const status = auth.getStatus();
    return {
      available: Boolean(legacySource && status.signedIn),
      verificationAvailable: verificationAvailable() && status.signedIn && status.runtimeSlot === "primary",
    };
  });
  const run = "chat:electron-preview-run";
  ipc.handle(run, async (event, raw) => {
    if (!options.isTrustedSender(event)) throw new Error("invalid request");
    const request = CHAT_ELECTRON_PREVIEW_INVOKE[run].request.safeParse(raw);
    if (!request.success) throw new Error("invalid request");
    if (request.data.requestKind === "verification" ? !verificationAvailable() : !legacySource) {
      return { status: "unavailable" };
    }
    return CHAT_ELECTRON_PREVIEW_INVOKE[run].response.parse(await service.run(request.data));
  });
  let lastHandled: { targetId: string; runId: string } | undefined;
  return {
    openVerification: setup?.open,
    async cancel(reason: "stopped" | "revoked" = "revoked") {
      if (reason === "stopped") setup?.revokeFullAccess(reason);
      else setup?.clearSetup();
      await service.cancel(reason);
    },
    async tryBackgroundPreview(
      context: ChatElectronPreviewBackgroundBinding["context"],
      grant: ChatElectronPreviewBackgroundBinding["grant"],
      signal: AbortSignal,
      beginPreview: () => boolean,
      pairing?: MacActionPairingLease,
    ) {
      if (!legacySource || signal.aborted) return;
      const target = await transport.readBackgroundPreviewTarget(context, grant, signal);
      if (!target || (lastHandled?.targetId === grant.targetId && lastHandled.runId === target.runId)) return;
      if (!beginPreview()) return;
      const { status } = await service.run(target, { context, grant, signal, pairing });
      if ((status === "returned" || status === "declined" || status === "already-handled") && !signal.aborted) {
        lastHandled = { targetId: grant.targetId, runId: target.runId };
      }
      if (status !== "busy" && !signal.aborted) console.info("[chat-electron-preview]", "background request", status);
    },
  };
}
