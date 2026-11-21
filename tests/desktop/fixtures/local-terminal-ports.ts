// The real port path of local terminal output, without Electron: the main
// process streams module, the preload's stream bridge, and Node MessagePorts
// standing in for MessagePortMain and the window's MessagePort.
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { vi } from "vitest";
import { createLocalTerminalStreams } from "@desktop/main/local-terminals/streams";
import { createLocalTerminalStreamBridge } from "@desktop/shared/local-terminal-stream-bridge";

type IpcListener = (event: unknown, payload: unknown) => void;

export function localTerminalPorts() {
  const listeners: IpcListener[] = [];
  const opened: MessagePort[] = [];
  // The window's end of each port as it was handed over, for tests that act as the preload would not.
  const handedOver = new Map<number, MessagePort>();
  const host = {
    acknowledge: vi.fn((_attachId: number, _count: number) => true),
    input: vi.fn((_attachId: number, _data: string, _binary: boolean) => true),
  };
  let windowOpen = true;
  const streams = createLocalTerminalStreams<MessagePort>({
    target: () => (windowOpen ? {
      postMessage: (channel, message, transfer) => {
        handedOver.set((message as { attachId: number }).attachId, transfer[0]!);
        for (const listener of listeners) listener({ ports: transfer }, message);
        void channel;
      },
    } : null),
    createChannel: () => {
      const { port1, port2 } = new MessageChannel();
      opened.push(port1, port2);
      return {
        port1: {
          postMessage: (message: unknown) => port1.postMessage(message),
          on: (_event: "message", listener: (event: { data: unknown }) => void) => port1.on("message", (data: unknown) => listener({ data })),
          start: () => port1.start(),
          close: () => port1.close(),
        },
        port2,
      };
    },
  });
  streams.bind(host);
  const bridge = createLocalTerminalStreamBridge({ on: (_channel, listener) => { listeners.push(listener); } });
  return {
    host,
    streams,
    bridge,
    /** The window is gone: ports can no longer be handed over. */
    closeWindow: () => { windowOpen = false; },
    /** What the core sends for this attachment, as the session sink receives it. */
    output: (attachId: number, data: string | Uint8Array) => streams.sink.outputBytes!(attachId, typeof data === "string" ? new TextEncoder().encode(data) : data),
    closed: (attachId: number) => streams.sink.closed(attachId),
    /** Posts straight into main's end of the attachment's port, skipping the preload. */
    raw: (attachId: number, message: unknown) => handedOver.get(attachId)!.postMessage(message),
    dispose: () => { for (const port of opened) port.close(); },
  };
}
