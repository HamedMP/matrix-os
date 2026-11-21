import { dialog, type BrowserWindow, type IpcMain } from "electron";
import type { AuthService } from "../auth/auth-service";
import type { LocalTerminalHost } from "../local-terminals/host";
import { createChatElectronPreviewTransport } from "../chat-electron-preview/transport";
import type { InvokeRequest, InvokeResponse } from "../../shared/ipc-contract";
import { MAC_TERMINAL_PROBE_INVOKE } from "../../shared/mac-terminal-probe-ipc";
import { createChatMacTerminalService } from "./service";

interface Options {
  auth: AuthService;
  host: LocalTerminalHost;
  allowed: boolean;
  window(): BrowserWindow | null;
  isTrustedSender(event: unknown): boolean;
}

export function registerChatMacTerminal(ipc: Pick<IpcMain, "handle">, options: Options) {
  const { auth, host } = options;
  const transport = createChatElectronPreviewTransport(auth);
  const service = createChatMacTerminalService({
    ...transport,
    enabled: options.allowed,
    async approve(context, signal) {
      const window = options.window();
      if (!window || window.isDestroyed()) return false;
      const answer = await dialog.showMessageBox(window, {
        type: "question",
        message: "Approve one Mac terminal check?",
        detail: [
          "The Main agent can run /usr/bin/uname -s once in a new dedicated terminal on this Mac.",
          "Output returns to the same Chat. This permission expires after five minutes.",
          `Chat ${context.chatId}`,
          `Worktree ${context.worktreeId}`,
        ].join("\n\n"),
        buttons: ["Cancel", "Approve Once"],
        cancelId: 0,
        defaultId: 0,
        signal,
      });
      return answer.response === 1;
    },
    prepareTerminal: () => host.prepareChatTerminalProbe(),
    reportError(error) {
      console.warn("[chat-mac-terminal] operation failed", error instanceof Error ? error.name : "Error");
    },
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
  handle("chat:mac-terminal-prepare", service.prepare);
  handle("chat:mac-terminal-run", service.run);
  handle("chat:mac-terminal-cancel", async ({ chatId }) => ({ ok: await service.cancel(chatId) }));
  return service.cancelAll;
}
