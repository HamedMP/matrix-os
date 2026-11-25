import { dialog, type BrowserWindow, type IpcMain } from "electron";
import type { AuthService } from "../auth/auth-service";
import type { MacActionPairing, MacActionPairingLease } from "../desktop-pairing/action";
import type { LocalTerminalHost } from "../local-terminals/host";
import type { BeginMacActivity } from "../mac-activity/activity";
import { createChatElectronPreviewTransport, type MacTerminalContext } from "../chat-electron-preview/transport";
import type { InvokeRequest, InvokeResponse } from "../../shared/ipc-contract";
import { MAC_TERMINAL_SYSTEM_CHECKS } from "../../shared/mac-terminal-probe";
import { MAC_TERMINAL_PROBE_INVOKE } from "../../shared/mac-terminal-probe-ipc";
import { createMacTerminalBackgroundService } from "./background-service";
import { createChatMacTerminalService } from "./service";

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
    context: MacTerminalContext, grant: { targetId: string; approvedAt: number }, signal: AbortSignal,
    beginPreview: () => boolean, pairing?: MacActionPairingLease,
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
    oneTimeBusy: service.isBusy,
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

  function handle<C extends keyof typeof MAC_TERMINAL_PROBE_INVOKE>(
    channel: C,
    handler: (request: InvokeRequest<C>) => InvokeResponse<C> | Promise<InvokeResponse<C>>,
  ) {
    const contract = MAC_TERMINAL_PROBE_INVOKE[channel];
    ipc.handle(channel, async (event, raw) => {
      if (!options.isTrustedSender(event)) throw new Error("invalid request");
      const value = contract.request.safeParse(raw);
      if (!value.success) throw new Error("invalid request");
      return contract.response.parse(await handler(value.data as InvokeRequest<C>));
    });
  }

  handle("chat:mac-terminal-available", () => {
    const status = auth.getStatus();
    return { available: service.available && status.signedIn && status.runtimeSlot === "primary" };
  });
  handle("chat:mac-terminal-prepare", (request) => background.isBusy() ? { status: "busy" } : service.prepare(request));
  handle("chat:mac-terminal-run", service.run);
  handle("chat:mac-terminal-background-start", background.start);
  handle("chat:mac-terminal-background-status", background.status);
  handle("chat:mac-terminal-cancel", async ({ chatId }) => {
    const [single, repeated] = await Promise.all([service.cancel(chatId), background.cancel(chatId)]);
    return { ok: single || repeated };
  });
  return {
    async cancelAll() { await Promise.all([service.cancelAll(), background.stop("authority-changed")]); },
    async stopAll() { await Promise.all([service.cancelAll("stopped"), background.stop()]); },
    stopBackground: background.stop,
  };
}
