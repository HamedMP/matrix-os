// IPC for the Desktop link (spec 2716). Terminal-window only: requests are
// validated here again, and failures reach the window as fixed reasons.
import { INVOKE_CHANNELS } from "../../shared/ipc-contract";
import { DESKTOP_LINK_INVOKE_CHANNELS } from "../../shared/desktop-link";
import { DesktopLinkEnableError, type DesktopLinkService } from "./service";

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, payload: unknown) => Promise<unknown> | unknown): void;
}

type Channel = (typeof DESKTOP_LINK_INVOKE_CHANNELS)[number];

export function registerDesktopLinkIpc(
  ipcMain: IpcMainLike,
  service: DesktopLinkService,
  authorizeSender: (event: unknown, channel: string) => boolean,
  emit: (channel: "desktop-link:changed", payload: unknown) => void,
): () => void {
  const handlers: Record<Channel, (request: never) => Promise<unknown>> = {
    "desktop-link:status": async () => ({ computers: service.statuses() }),
    "desktop-link:this-device": async () => ({ deviceIds: service.deviceIds() }),
    "desktop-link:enable": async ({ slot, computerName }: { slot: string; computerName: string }) => {
      try {
        await service.enable(slot, computerName);
        return { ok: true };
      } catch (error: unknown) {
        if (error instanceof DesktopLinkEnableError) return { ok: false, reason: error.reason };
        console.warn("[desktop-link] enable failed:", error instanceof Error ? error.name : "UnknownError");
        return { ok: false, reason: "unavailable" };
      }
    },
    "desktop-link:disable": async ({ slot }: { slot: string }) => {
      try {
        await service.disable(slot);
        return { ok: true };
      } catch (error: unknown) {
        // The link is already closed when this fails; only the saved choice may lag.
        console.warn("[desktop-link] disable failed:", error instanceof Error ? error.name : "UnknownError");
        return { ok: false };
      }
    },
  };
  for (const channel of DESKTOP_LINK_INVOKE_CHANNELS) {
    ipcMain.handle(channel, async (event, payload) => {
      const request = INVOKE_CHANNELS[channel].request.safeParse(payload ?? {});
      if (!request.success || !authorizeSender(event, channel)) throw new Error("invalid request");
      const response = INVOKE_CHANNELS[channel].response.safeParse(await handlers[channel](request.data as never));
      if (!response.success) throw new Error("internal error");
      return response.data;
    });
  }
  return service.onStatus((status) => emit("desktop-link:changed", status));
}
