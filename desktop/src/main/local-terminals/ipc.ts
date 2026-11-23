// IPC for local terminals. Every channel is Terminal-window-only; requests are
// validated here again, and failures reach the renderer as fixed outcomes.
import { INVOKE_CHANNELS, type InvokeRequest, type InvokeResponse } from "../../shared/ipc-contract";
import { LOCAL_TERMINAL_INVOKE_CHANNELS } from "../../shared/local-terminals";
import { describeError } from "./describe-error";
import { HcCallError } from "./hc-client";
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
    "local-terminal:create": async ({ cols, rows, agent, folder, machine }) => {
      try {
        const id = await host.create({ cols, rows }, { ...(agent ? { agent } : {}), ...(folder ? { folder } : {}), ...(machine ? { machine } : {}) });
        return id ? { status: "ready", id } : { status: "rate-limited" };
      } catch (error: unknown) { logFailure("local-terminal:create", error); return unavailable(); }
    },
    "local-terminal:kill": async ({ id }) => {
      try { await host.kill(id); return { ok: true }; }
      catch (error: unknown) { logFailure("local-terminal:kill", error); return { ok: false }; }
    },
    "local-terminal:machines": async () => {
      try { return { status: "ready", machines: await host.machines() }; }
      catch (error: unknown) { logFailure("local-terminal:machines", error); return unavailable(); }
    },
    "local-terminal:machine-add": async ({ target, name, ssh }) => {
      try { return await host.addMachine({ target, ...(name ? { name } : {}), ...(ssh ? { ssh } : {}) }); }
      catch (error: unknown) { logFailure("local-terminal:machine-add", error); return { ok: false, reason: "unavailable" }; }
    },
    "local-terminal:machine-remove": async ({ name }) => {
      try { await host.removeMachine(name); return { ok: true }; }
      catch (error: unknown) { logFailure("local-terminal:machine-remove", error); return { ok: false }; }
    },
    "local-terminal:machine-connect": async ({ name }) => {
      try { await host.connectMachine(name); return { ok: true }; }
      catch (error: unknown) { logFailure("local-terminal:machine-connect", error); return { ok: false }; }
    },
    "local-terminal:tailscale-peers": async () => {
      try { return await host.tailscalePeers(); }
      catch (error: unknown) { logFailure("local-terminal:tailscale-peers", error); return { status: "unavailable" }; }
    },
    "local-terminal:machine-login": async ({ name, cols, rows }) => {
      try {
        const id = await host.machineLogin(name, { cols, rows });
        return id && !id.includes("/") ? { status: "ready", id } : { status: "rate-limited" };
      } catch (error: unknown) { logFailure("local-terminal:machine-login", error); return unavailable(); }
    },
    "local-terminal:ssh-login": async ({ target, ssh, cols, rows }) => {
      try {
        const id = await host.sshLogin(target, { cols, rows }, ssh);
        return id && !id.includes("/") ? { status: "ready", id } : { status: "rate-limited" };
      } catch (error: unknown) { logFailure("local-terminal:ssh-login", error); return unavailable(); }
    },
    "local-terminal:remove": async ({ id }) => {
      try { await host.remove(id); return { ok: true }; }
      catch (error: unknown) { logFailure("local-terminal:remove", error); return { ok: false }; }
    },
    "local-terminal:rename": async ({ id, name }) => {
      try { await host.rename(id, name); return { ok: true }; }
      catch (error: unknown) { logFailure("local-terminal:rename", error); return { ok: false }; }
    },
    "local-terminal:put": async ({ id, name, dataBase64 }) => {
      try { return { ok: true, path: await host.put(id, name, dataBase64) }; }
      catch (error: unknown) { logFailure("local-terminal:put", error); return { ok: false }; }
    },
    "local-terminal:attach": async ({ id, cols, rows }) => {
      try { return { ok: true, attachId: await host.attach(id, { cols, rows }) }; }
      catch (error: unknown) {
        // A terminal whose program has ended cannot be attached; the pane shows it ended. Not a failure.
        if (!(error instanceof HcCallError && error.kind === "finished")) logFailure("local-terminal:attach", error);
        return { ok: false };
      }
    },
    "local-terminal:input": ({ attachId, data, binary }) => quiet("local-terminal:input", () => host.input(attachId, data, binary === true)),
    "local-terminal:resize": ({ attachId, cols, rows }) => quiet("local-terminal:resize", () => host.resize(attachId, { cols, rows })),
    "local-terminal:ack": ({ attachId, count }) => quiet("local-terminal:ack", () => host.acknowledge(attachId, count)),
    "local-terminal:detach": ({ attachId }) => quiet("local-terminal:detach", () => host.detach(attachId)),
    "local-terminal:watch": async () => {
      try { return { status: "ready", terminals: await host.watch() }; }
      catch (error: unknown) { logFailure("local-terminal:watch", error); return unavailable(); }
    },
    "local-terminal:seen": async ({ id }) => {
      try { await host.seen(id); return { ok: true }; }
      catch (error: unknown) { logFailure("local-terminal:seen", error); return { ok: false }; }
    },
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
