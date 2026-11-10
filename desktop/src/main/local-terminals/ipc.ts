// IPC for local terminals. Every channel is Terminal-window-only; requests are
// validated here again, and failures reach the renderer as fixed outcomes.
import { INVOKE_CHANNELS, type InvokeRequest, type InvokeResponse } from "../../shared/ipc-contract";
import { LOCAL_TERMINAL_INVOKE_CHANNELS } from "../../shared/local-terminals";
import { describeError } from "./describe-error";
import type { LocalTerminalHost } from "./host";

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, payload: unknown) => Promise<unknown> | unknown): void;
}

type Channel = (typeof LOCAL_TERMINAL_INVOKE_CHANNELS)[number];
type Handlers = { [C in Channel]: (request: InvokeRequest<C>) => Promise<InvokeResponse<C>> | InvokeResponse<C> };

function logFailure(channel: string, error: unknown): void {
  console.warn(`[local-terminals] ${channel} failed:`, describeError(error));
}

export function registerLocalTerminalIpc(
  ipcMain: IpcMainLike,
  host: LocalTerminalHost,
  authorizeSender: (event: unknown, channel: string) => boolean,
): void {
  if (typeof host?.list !== "function" || typeof authorizeSender !== "function") {
    throw new Error("local terminal service unavailable");
  }
  // A failure while the host is otherwise healthy is still "unavailable".
  const unavailable = () => {
    const status = host.status();
    return { status: status === "ready" ? "unavailable" as const : status };
  };
  const quiet = (channel: Channel, action: () => boolean | void) => {
    try { return { ok: action() !== false }; }
    catch (error: unknown) { logFailure(channel, error); return { ok: false }; }
  };
  const handlers: Handlers = {
    "local-terminal:list": async () => {
      try { return { status: "ready", terminals: await host.list() }; }
      catch (error: unknown) { logFailure("local-terminal:list", error); return unavailable(); }
    },
    "local-terminal:create": async ({ cols, rows }) => {
      try {
        const id = await host.create({ cols, rows });
        return id ? { status: "ready", id } : { status: "limit" };
      } catch (error: unknown) { logFailure("local-terminal:create", error); return unavailable(); }
    },
    "local-terminal:kill": async ({ id }) => {
      try { await host.kill(id); return { ok: true }; }
      catch (error: unknown) { logFailure("local-terminal:kill", error); return { ok: false }; }
    },
    "local-terminal:attach": async ({ id, cols, rows }) => {
      try { return { ok: true, attachId: await host.attach(id, { cols, rows }) }; }
      catch (error: unknown) { logFailure("local-terminal:attach", error); return { ok: false }; }
    },
    "local-terminal:input": ({ attachId, data, binary }) => quiet("local-terminal:input", () => host.input(attachId, data, binary === true)),
    "local-terminal:resize": ({ attachId, cols, rows }) => quiet("local-terminal:resize", () => host.resize(attachId, { cols, rows })),
    "local-terminal:ack": ({ attachId, count }) => quiet("local-terminal:ack", () => host.acknowledge(attachId, count)),
    "local-terminal:detach": ({ attachId }) => quiet("local-terminal:detach", () => host.detach(attachId)),
  };

  for (const channel of LOCAL_TERMINAL_INVOKE_CHANNELS) {
    ipcMain.handle(channel, async (event, payload) => {
      const request = INVOKE_CHANNELS[channel].request.safeParse(payload ?? {});
      if (!request.success || !authorizeSender(event, channel)) throw new Error("invalid request");
      const run = handlers[channel] as (input: unknown) => Promise<unknown> | unknown;
      const response = INVOKE_CHANNELS[channel].response.safeParse(await run(request.data));
      if (!response.success) throw new Error("internal error");
      return response.data;
    });
  }
}
