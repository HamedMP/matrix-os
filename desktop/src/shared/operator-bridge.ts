// The renderer-facing `window.operator` bridge. Payloads are validated here
// and again in main. A Terminal window gets only its allowlisted channels.
import { EVENT_CHANNELS, INVOKE_CHANNELS, type EventChannel, type InvokeChannel } from "./ipc-contract";
import { windowMayInvoke, windowMayListen, type WindowRole } from "./terminal-window";

export type OperatorBridgeRole = WindowRole;

interface IpcRendererLike {
  invoke(channel: string, payload: unknown): Promise<unknown>;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): unknown;
}

export function createOperatorBridge(ipc: IpcRendererLike, role: OperatorBridgeRole) {
  return {
    invoke(channel: string, payload: unknown): Promise<unknown> {
      const entry = Object.hasOwn(INVOKE_CHANNELS, channel) ? INVOKE_CHANNELS[channel as InvokeChannel] : undefined;
      if (!entry || !windowMayInvoke(role, channel)) return Promise.reject(new Error("unknown channel"));
      const parsed = entry.request.safeParse(payload ?? {});
      if (!parsed.success) return Promise.reject(new Error("invalid request"));
      return ipc.invoke(channel, parsed.data);
    },

    on(channel: string, callback: (payload: unknown) => void): () => void {
      const schema = Object.hasOwn(EVENT_CHANNELS, channel) ? EVENT_CHANNELS[channel as EventChannel] : undefined;
      if (!schema || !windowMayListen(role, channel)) return () => undefined;
      const listener = (_event: unknown, payload: unknown) => {
        const parsed = schema.safeParse(payload);
        if (parsed.success) callback(parsed.data);
      };
      ipc.on(channel, listener);
      return () => {
        ipc.removeListener(channel, listener);
      };
    },
  };
}
