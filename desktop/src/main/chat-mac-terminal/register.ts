import { dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from "electron";
import type { AuthService } from "../auth/auth-service";
import type { MacActionPairing, MacActionPairingLease } from "../desktop-pairing/action";
import type { LocalTerminalHost } from "../local-terminals/host";
import type { BeginMacActivity } from "../mac-activity/activity";
import { createChatElectronPreviewTransport, type MacTerminalContext } from "../chat-electron-preview/transport";
import type { InvokeRequest, InvokeResponse } from "../../shared/ipc-contract";
import { MAC_TERMINAL_SYSTEM_CHECKS } from "../../shared/mac-terminal-probe";
import { MAC_TERMINAL_PROBE_INVOKE } from "../../shared/mac-terminal-probe-ipc";
import { createMacTerminalBackgroundService } from "./background-service";
import { approveExistingMacTerminal, approveMacTerminalWatch, pickExistingMacTerminal } from "./existing-terminal-dialog";
import { createMacExistingTerminalService } from "./existing-terminal-service";
import { createChatMacTerminalService } from "./service";
import { createMacTerminalWatch } from "./watch-existing-terminal-service";

interface Options {
  auth: AuthService;
  acquireActionPairing: MacActionPairing;
  host: LocalTerminalHost;
  allowed: boolean;
  window(): BrowserWindow | null;
  isTrustedSender(event: unknown): boolean;
  onBackgroundActiveChange?(active: boolean): void;
  beginActivity?: BeginMacActivity;
  transport?: ReturnType<typeof createChatElectronPreviewTransport>;
  tryBackgroundPreview?(
    context: MacTerminalContext, grant: { targetId: string; approvedAt: number },
    signal: AbortSignal, pairing?: MacActionPairingLease,
  ): Promise<void>;
}

export function registerChatMacTerminal(ipc: Pick<IpcMain, "handle">, options: Options) {
  const { auth, host } = options;
  const transport = options.transport ?? createChatElectronPreviewTransport(auth);
  async function requestConsent(context: MacTerminalContext, signal: AbortSignal, prompt: {
    message: string;
    description: string[];
    approveLabel: string;
  }) {
    const window = options.window();
    if (!window || window.isDestroyed()) return false;
    const answer = await dialog.showMessageBox(window, {
      type: "question",
      message: prompt.message,
      detail: [...prompt.description, `Chat ${context.chatId}`, `Worktree ${context.worktreeId}`].join("\n\n"),
      buttons: ["Cancel", prompt.approveLabel],
      cancelId: 0,
      defaultId: 0,
      signal,
    });
    return answer.response === 1;
  }

  const service = createChatMacTerminalService({
    ...transport,
    beginActivity: options.beginActivity,
    acquireActionPairing: options.acquireActionPairing,
    enabled: options.allowed,
    approve: (context, signal) => requestConsent(context, signal, {
      message: "Approve one Mac terminal check?",
      description: [
        "The Main agent can run /usr/bin/uname -s once in a new dedicated terminal on this Mac.",
        "Output returns to the same Chat. This permission expires after five minutes.",
      ],
      approveLabel: "Approve Once",
    }),
    prepareTerminal: () => host.prepareChatTerminalProbe(),
    reportError(error) {
      console.warn("[chat-mac-terminal] operation failed", error instanceof Error ? error.name : "Error");
    },
  });
  const background = createMacTerminalBackgroundService({
    ...transport,
    beginActivity: options.beginActivity,
    acquireActionPairing: options.acquireActionPairing,
    enabled: options.allowed,
    oneTimeBusy: () => service.isBusy() || existing.isBusy() || watch.isBusy(),
    approve: (context, signal) => requestConsent(context, signal, {
      message: "Allow background Mac terminal checks?",
      description: [
        `The Main agent can run these read-only commands up to three times in dedicated terminals on this Mac:\n${MAC_TERMINAL_SYSTEM_CHECKS.join("\n")}`,
        "Checks can run while this Chat is closed. Output returns to this Chat. This permission expires after 15 minutes.",
        ...(options.tryBackgroundPreview ? [
          "This also allows the Main agent to request an Electron Desktop preview. Every preview still asks for separate approval on this Mac.",
        ] : []),
      ],
      approveLabel: "Approve for 15 minutes",
    }),
    prepareTerminal: host.prepareChatTerminalProbe,
    tryBackgroundPreview: options.tryBackgroundPreview,
    onActiveChange: (active) => options.onBackgroundActiveChange?.(active),
    reportEvent: (event, reason) => console.info("[chat-mac-terminal-background]", event, reason ?? ""),
  });

  const existing = createMacExistingTerminalService({
    enabled: options.allowed,
    terminalBusy: () => service.isBusy() || background.isBusy() || watch.isBusy(),
    readTerminalContext: transport.readTerminalContext,
    isTerminalContextCurrent: transport.isTerminalContextCurrent,
    openReader: host.openExistingTerminalReader,
    acquireActionPairing: options.acquireActionPairing,
    beginActivity: options.beginActivity,
    reportError(error) {
      console.warn("[chat-mac-terminal] snapshot failed", error instanceof Error ? error.name : "Error");
    },
  });

  const watch = createMacTerminalWatch({
    enabled: options.allowed,
    terminalBusy: () => service.isBusy() || background.isBusy() || existing.isBusy(),
    readTerminalContext: transport.readTerminalContext,
    isTerminalContextCurrent: transport.isTerminalContextCurrent,
    openReader: host.openExistingTerminalReader,
    acquireActionPairing: options.acquireActionPairing,
    beginActivity: options.beginActivity,
    reportError(error) {
      console.warn("[chat-mac-terminal] watch failed", error instanceof Error ? error.name : "Error");
    },
  });

  function handle<C extends keyof typeof MAC_TERMINAL_PROBE_INVOKE>(
    channel: C,
    handler: (request: InvokeRequest<C>, event: IpcMainInvokeEvent) => InvokeResponse<C> | Promise<InvokeResponse<C>>,
  ) {
    const contract = MAC_TERMINAL_PROBE_INVOKE[channel];
    ipc.handle(channel, async (event, raw) => {
      if (!options.isTrustedSender(event)) throw new Error("invalid request");
      const value = contract.request.safeParse(raw);
      if (!value.success) throw new Error("invalid request");
      return contract.response.parse(await handler(value.data as InvokeRequest<C>, event));
    });
  }

  handle("chat:mac-terminal-available", () => {
    const status = auth.getStatus();
    return { available: service.available && status.signedIn && status.runtimeSlot === "primary" };
  });
  handle("chat:mac-terminal-prepare", (request) =>
    background.isBusy() || existing.isBusy() || watch.isBusy() ? { status: "busy" } : service.prepare(request));
  handle("chat:mac-terminal-read-existing", async (request, event) => {
    const window = options.window();
    if (!window || window.isDestroyed()) return { status: "unavailable" };
    const closed = () => { void existing.cancel("revoked", request.chatId); };
    window.once("closed", closed);
    try {
      return await existing.run(request, {
        isCurrent: () => !window.isDestroyed() && options.window() === window && options.isTrustedSender(event),
        pick: (terminals, signal) => pickExistingMacTerminal(window, terminals, signal),
        approve: (context, terminal, output, signal) => approveExistingMacTerminal(window, context, terminal, output, signal),
      });
    } finally {
      window.removeListener("closed", closed);
    }
  });
  handle("chat:mac-terminal-watch-start", (request, event) => {
    const window = options.window();
    const { sender, senderFrame } = event;
    if (!window || window.isDestroyed() || window.webContents !== sender || !senderFrame) {
      return { status: "unavailable" };
    }
    return watch.start(request, {
      sender: senderFrame,
      isCurrent: () => !window.isDestroyed() && options.window() === window
        && event.senderFrame === senderFrame && options.isTrustedSender(event),
      pick: (terminals, signal) => pickExistingMacTerminal(window, terminals, signal),
      approve: (context, terminal, signal) => approveMacTerminalWatch(window, context, terminal, signal),
      onClose(close) {
        const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
          if (details.isMainFrame && !details.isSameDocument) close();
        };
        window.once("closed", close);
        sender.once("render-process-gone", close);
        sender.on("did-start-navigation", onNavigation);
        return () => {
          window.removeListener("closed", close);
          sender.removeListener("render-process-gone", close);
          sender.removeListener("did-start-navigation", onNavigation);
        };
      },
    });
  });
  handle("chat:mac-terminal-watch-read", (request, event) =>
    event.senderFrame ? watch.read(request, event.senderFrame) : { status: "ended" });
  handle("chat:mac-terminal-watch-stop", (request, event) =>
    event.senderFrame ? watch.stop(request, event.senderFrame) : { ok: false });
  handle("chat:mac-terminal-run", service.run);
  handle("chat:mac-terminal-background-start", background.start);
  handle("chat:mac-terminal-background-status", background.status);
  handle("chat:mac-terminal-cancel", async ({ chatId }) => {
    const [single, repeated, snapshot, watchStopped] = await Promise.all([
      service.cancel(chatId), background.cancel(chatId), existing.cancel("stopped", chatId), watch.cancel("stopped", chatId),
    ]);
    return { ok: single || repeated || snapshot || watchStopped };
  });
  return {
    async cancelAll() {
      await Promise.all([
        service.cancelAll(), background.stop("authority-changed"), existing.cancel("revoked"), watch.cancel("revoked"),
      ]);
    },
    async stopAll() {
      await Promise.all([
        service.cancelAll("stopped"), background.stop(), existing.cancel("stopped"), watch.cancel("stopped"),
      ]);
    },
    stopBackground: background.stop,
  };
}
