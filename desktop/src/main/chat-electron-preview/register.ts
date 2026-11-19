import type { BrowserWindow, IpcMain } from "electron";
import { isAbsolute, join } from "node:path";
import type { MacActionPairing, MacActionPairingLease } from "../desktop-pairing/action";
import type { AuthService } from "../auth/auth-service";
import { CHAT_ELECTRON_PREVIEW_INVOKE, type MacVerificationChatScope } from "../../shared/chat-electron-preview-ipc";
import type { BeginMacActivity } from "../mac-activity/activity";
import { showMacActivityDialog } from "../mac-activity/dialog";
import { createChatElectronPreviewClaims } from "./claims";
import { runChatElectronPreview } from "./executor";
import { createChatElectronPreviewService } from "./service";
import type { ChatElectronPreviewBackgroundBinding, ChatElectronPreviewRequest, createChatElectronPreviewTransport } from "./transport";
import { createMacVerificationSourceProvider } from "./source-provider";

interface RegistrationOptions {
  auth: AuthService;
  acquireActionPairing: MacActionPairing;
  acquireFullAccessPairing?: MacActionPairing;
  transport: ReturnType<typeof createChatElectronPreviewTransport>;
  allowed: boolean;
  macVerificationAllowed?: boolean;
  checkout?: string;
  userData: string;
  resourcesPath?: string;
  electronPath: string;
  window(): BrowserWindow | null;
  isTrustedSender(event: unknown): boolean;
  beginActivity?: BeginMacActivity;
}

interface FullAccessSelection {
  viewId: string;
  scope: MacVerificationChatScope;
  controller: AbortController;
  isTrusted(): boolean;
}

export function registerChatElectronPreview(ipc: Pick<IpcMain, "handle">, options: RegistrationOptions) {
  const { auth, transport, checkout, userData, electronPath, acquireFullAccessPairing } = options;
  let selection: FullAccessSelection | undefined;
  function clearFullAccessSelection() {
    const current = selection;
    selection = undefined;
    current?.controller.abort("revoked");
  }
  const legacySource = options.allowed && checkout && isAbsolute(checkout) ? { checkout, electronPath } : null;
  const sourceProvider = options.macVerificationAllowed ? createMacVerificationSourceProvider({
    resourcesPath: options.resourcesPath ?? process.resourcesPath, userData,
  }) : null;
  function verificationAvailable() {
    return Boolean(sourceProvider || legacySource);
  }
  function isAutomatic(request: ChatElectronPreviewRequest) {
    return request.requestKind === "verification" && Boolean(sourceProvider);
  }
  function resolveSource(request: ChatElectronPreviewRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    return legacySource;
  }
  // The service admits only one action at a time. Match the selected local
  // source against the one shown during approval after the cloud reread.
  let approvedSource: { checkout: string; electronPath: string; identity?: string } | null = null;
  const service = createChatElectronPreviewService({
    ...transport,
    beginActivity: options.beginActivity,
    acquireActionPairing: options.acquireActionPairing,
    ...createChatElectronPreviewClaims(join(userData, "chat-electron-preview-claims")),
    enabled: verificationAvailable(),
    async approve(request, signal) {
      approvedSource = null;
      const source = isAutomatic(request) ? null : await resolveSource(request, signal);
      signal.throwIfAborted();
      if (!source && !isAutomatic(request)) return false;
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
          source ? `Mac checkout ${source.checkout}` : "Prepare matching source and install pinned dependencies in a private cache on this Mac.",
          `Commit ${request.baseSha}`,
          `Source SHA-256 ${request.sourceSha256}`,
          request.recipe === "files-trash" ? "Verify right-click Move to Trash and Undo with disposable files."
            : request.requestKind === "verification" ? `Sign-in label: ${request.label}` : `New sign-in label: ${request.label}`,
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
      if (isAutomatic(request) && sourceProvider) {
        // Service calls execute only after local consent, an active pairing
        // lease and a second canonical source read. Preparing source must not
        // create files before those authority checks.
        const source = await sourceProvider.prepare(request.baseSha, signal);
        try {
          signal.throwIfAborted();
          if (!await source.check(signal)) throw new Error("preview support changed");
          const result = await runChatElectronPreview({
            checkout: source.checkout, electronPath: source.electronPath, toolchain: source.toolchain,
            baseSha: request.baseSha, sourceSha256: request.sourceSha256, label: request.label,
            operation: request.operation, requestKind: request.requestKind, recipe: request.recipe, signal,
          });
          if (!await source.check(signal)) throw new Error("preview support changed");
          return result;
        } finally { await source.release(); }
      }
      const source = await resolveSource(request, signal);
      signal.throwIfAborted();
      const identity = source && "identity" in source ? source.identity : undefined;
      if (!source || source.checkout !== approvedSource?.checkout || source.electronPath !== approvedSource.electronPath
        || identity !== approvedSource.identity) throw new Error("preview source changed");
      approvedSource = null;
      return runChatElectronPreview({
        checkout: source.checkout, electronPath: source.electronPath, baseSha: request.baseSha,
        sourceSha256: request.sourceSha256, label: request.label, operation: request.operation,
        requestKind: request.requestKind, recipe: request.recipe, signal,
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
      ...(verificationAvailable() && status.signedIn && status.runtimeSlot === "primary" ? { terminalRequests: true } : {}),
    };
  });
  const terminalIntent = "chat:mac-verification-terminal-intent";
  ipc.handle(terminalIntent, async (event, raw) => {
    if (!options.isTrustedSender(event)) throw new Error("invalid request");
    const ref = CHAT_ELECTRON_PREVIEW_INVOKE[terminalIntent].request.parse(raw);
    if (!verificationAvailable()) return { digest: null };
    const digest = await transport.probeTerminalIntent(ref);
    return { digest: verificationAvailable() && options.isTrustedSender(event) ? digest : null };
  });
  const select = "chat:mac-verification-selection";
  ipc.handle(select, (event, raw) => {
    if (!options.isTrustedSender(event)) throw new Error("invalid request");
    const { viewId, scope } = CHAT_ELECTRON_PREVIEW_INVOKE[select].request.parse(raw);
    if (!scope) {
      if (selection?.viewId === viewId) clearFullAccessSelection();
      return { accepted: true };
    }
    clearFullAccessSelection();
    if (!verificationAvailable()) return { accepted: false };
    selection = {
      viewId, scope, controller: new AbortController(), isTrusted: () => options.isTrustedSender(event),
    };
    return { accepted: true };
  });

  function bindFullAccess(current: FullAccessSelection, isTrustedRequest: () => boolean) {
    const isCurrent = () => selection === current && !current.controller.signal.aborted
      && current.isTrusted() && isTrustedRequest();
    return {
      signal: current.controller.signal,
      async acquire(request: ChatElectronPreviewRequest, operation: AbortController, signal: AbortSignal) {
        if (request.requestKind !== "verification" || request.operation || request.backgroundTargetId
          || request.chatId !== current.scope.chatId || request.projectId !== current.scope.projectId
          || request.worktreeId !== current.scope.worktreeId || !acquireFullAccessPairing) return null;
        approvedSource = null;
        function requireCurrent() {
          if (!isCurrent()) operation.abort("revoked");
          return !signal.aborted;
        }
        if (!requireCurrent()) return null;
        const lease = await acquireFullAccessPairing(operation, signal);
        if (!requireCurrent()) {
          lease?.close();
          return null;
        }
        if (!lease) return null;
        const source = isAutomatic(request) ? null : await resolveSource(request, signal);
        if (!requireCurrent() || (!source && !isAutomatic(request))) {
          lease.close();
          return null;
        }
        approvedSource = source;
        return {
          close: lease.close,
          async check(boundarySignal?: AbortSignal, retryBadGateway?: () => boolean) {
            if (!isCurrent()) operation.abort("revoked");
            if (boundarySignal?.aborted || operation.signal.aborted
              || !await lease.check(boundarySignal, retryBadGateway)) return false;
            if (source) {
              const verified = await resolveSource(request, boundarySignal ?? operation.signal);
              if (!verified || ("identity" in verified ? verified.identity : undefined) !== ("identity" in source ? source.identity : undefined)) operation.abort("revoked");
            }
            if (!isCurrent()) operation.abort("revoked");
            return !operation.signal.aborted && !boundarySignal?.aborted;
          },
        };
      },
    };
  }

  const run = "chat:electron-preview-run";
  ipc.handle(run, async (event, raw) => {
    if (!options.isTrustedSender(event)) throw new Error("invalid request");
    const request = CHAT_ELECTRON_PREVIEW_INVOKE[run].request.safeParse(raw);
    if (!request.success) throw new Error("invalid request");
    const { fullAccessViewId, ...target } = request.data;
    if ((target.terminalIntentDigest && !verificationAvailable())
      || (target.requestKind === "verification" ? !verificationAvailable() : !legacySource)) {
      return { status: "unavailable" };
    }
    // A renderer may lose its selection between acknowledging the mode and
    // requesting a run. Never turn a stale Full Access request into a prompt.
    let foreground: ReturnType<typeof bindFullAccess> | undefined;
    if (fullAccessViewId) {
      if (selection?.viewId !== fullAccessViewId || selection.scope.chatId !== target.chatId
        || !selection.isTrusted()) return { status: "unavailable" };
      foreground = bindFullAccess(selection, () => options.isTrustedSender(event));
    }
    return CHAT_ELECTRON_PREVIEW_INVOKE[run].response.parse(await service.run(target, undefined, foreground));
  });
  let lastHandled: { targetId: string; runId: string } | undefined;
  return {
    openVerification: sourceProvider ? async () => {
      await showMacActivityDialog(options.window(), {
        title: "Matrix", type: "info", message: "Mac Verification is prepared automatically.",
        detail: "Pair this Mac once, then use /mac-verification in your private worktree Chat. Matrix selects the task version, prepares temporary source, installs pinned dependencies in a private cache, runs supported checks and returns the result to that Chat. Manage Chat Full Access or disconnect in Mac Pairing.",
        buttons: ["Done"],
      });
    } : undefined,
    clearFullAccessSelection,
    async cancel(reason: "stopped" | "revoked" = "revoked") {
      if (reason === "revoked") {
        clearFullAccessSelection();
      }
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
