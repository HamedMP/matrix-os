// The only bridge between renderer and trusted core. Exposes exactly the
// typed contract — payloads are validated here AND in main (defense in depth,
// FR-081). The credential never crosses this boundary.
import { contextBridge, ipcRenderer } from "electron";
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  type EventChannel,
  type InvokeChannel,
} from "../shared/ipc-contract";

const api = {
  invoke(channel: string, payload: unknown): Promise<unknown> {
    const entry = INVOKE_CHANNELS[channel as InvokeChannel];
    if (!entry) return Promise.reject(new Error("unknown channel"));
    const parsed = entry.request.safeParse(payload ?? {});
    if (!parsed.success) return Promise.reject(new Error("invalid request"));
    return ipcRenderer.invoke(channel, parsed.data);
  },

  on(channel: string, callback: (payload: unknown) => void): () => void {
    const schema = EVENT_CHANNELS[channel as EventChannel];
    if (!schema) return () => undefined;
    const listener = (_event: unknown, payload: unknown) => {
      const parsed = schema.safeParse(payload);
      if (parsed.success) callback(parsed.data);
    };
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
};

export type OperatorBridge = typeof api;

contextBridge.exposeInMainWorld("operator", api);
