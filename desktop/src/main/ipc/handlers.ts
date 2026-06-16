// IPC handler registration. Every request and response is validated against
// the shared contract (FR-081); failures are rejected with generic messages
// and logged with detail on the trusted side only.
import { INVOKE_CHANNELS, type InvokeChannel, type InvokeRequest, type InvokeResponse } from "../../shared/ipc-contract";
import type { AuthService } from "../auth/auth-service";
import type { LocalStore, LocalStoreKey } from "../persistence/local-store";

interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: unknown, payload: unknown) => Promise<unknown> | unknown,
  ): void;
}

export interface HandlerContext {
  auth: AuthService;
  store: LocalStore;
  openExternal: (url: string) => Promise<void>;
  setBadgeCount: (count: number) => void;
  notify: (input: { threadId: string; title: string; body: string; kind: string }) => void;
  onRuntimeChanged: (slot: string) => void;
}

type Handler<C extends InvokeChannel> = (
  payload: InvokeRequest<C>,
) => Promise<InvokeResponse<C>> | InvokeResponse<C>;

const PUBLIC_IPC_ERRORS = new Set(["invalid request", "internal error", "embed unavailable"]);

export function registerIpcHandlers(ipcMain: IpcMainLike, ctx: HandlerContext): void {
  function handle<C extends InvokeChannel>(channel: C, handler: Handler<C>): void {
    ipcMain.handle(channel, async (_event, rawPayload) => {
      const parsedRequest = INVOKE_CHANNELS[channel].request.safeParse(rawPayload ?? {});
      if (!parsedRequest.success) {
        console.warn(`[ipc] rejected malformed request on ${channel}`);
        throw new Error("invalid request");
      }
      let result: InvokeResponse<C>;
      try {
        result = await handler(parsedRequest.data as InvokeRequest<C>);
      } catch (err: unknown) {
        console.warn(
          `[ipc] handler for ${channel} failed:`,
          err instanceof Error ? err.message : String(err),
        );
        if (err instanceof Error && PUBLIC_IPC_ERRORS.has(err.message)) {
          throw err;
        }
        throw new Error("internal error");
      }
      const parsedResponse = INVOKE_CHANNELS[channel].response.safeParse(result);
      if (!parsedResponse.success) {
        console.warn(`[ipc] handler for ${channel} produced an invalid response`);
        throw new Error("internal error");
      }
      return parsedResponse.data;
    });
  }

  handle("auth:start-device-flow", () => ctx.auth.startDeviceFlow());
  handle("auth:poll", () => ctx.auth.poll());
  handle("auth:status", () => ctx.auth.getStatus());
  handle("auth:sign-out", async () => {
    await ctx.auth.signOut();
    return { ok: true };
  });

  handle("runtime:select", async ({ slot }) => {
    await ctx.auth.selectRuntime(slot);
    ctx.onRuntimeChanged(slot);
    return { ok: true };
  });

  handle("state:get", async ({ key }) => ({
    value: await ctx.store.get(key as LocalStoreKey),
  }));
  handle("state:set", async ({ key, value }) => {
    try {
      await ctx.store.setUnknown(key as LocalStoreKey, value);
    } catch (err: unknown) {
      console.warn(
        `[ipc] state:set rejected for key ${key}:`,
        err instanceof Error ? err.message : String(err),
      );
      throw new Error("invalid request");
    }
    return { ok: true };
  });
  handle("state:set-panel-layout", async ({ taskKey, layout }) => {
    try {
      await ctx.store.setPanelLayout(taskKey, layout);
    } catch (err: unknown) {
      console.warn(
        "[ipc] state:set-panel-layout rejected:",
        err instanceof Error ? err.message : String(err),
      );
      throw new Error("invalid request");
    }
    return { ok: true };
  });

  handle("shell:open-external", async ({ url }) => {
    await ctx.openExternal(url);
    return { ok: true };
  });

  handle("badge:set", ({ count }) => {
    ctx.setBadgeCount(count);
    return { ok: true };
  });

  handle("notify", (payload) => {
    ctx.notify(payload);
    return { ok: true };
  });

  // Embeds land in Phase 7 (US5); until then the channels exist but refuse.
  handle("embed:open", () => {
    throw new Error("embed unavailable");
  });
  handle("embed:set-bounds", () => ({ ok: false }));
  handle("embed:close", () => ({ ok: false }));
  handle("embed:retry-auth", () => ({ ok: false }));

  handle("update:check", () => ({ status: "disabled" as const }));
}
