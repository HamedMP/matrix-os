// Typed access to the preload bridge. All payloads are re-validated in the
// preload and in main; this wrapper provides compile-time types.
import type {
  EventChannel,
  EventPayload,
  InvokeChannel,
  InvokeRequest,
  InvokeResponse,
} from "../../../shared/ipc-contract";
import type { LocalTerminalStream, LocalTerminalStreamHandlers } from "../../../shared/local-terminal-stream-bridge";

interface OperatorBridgeRaw {
  invoke(channel: string, payload: unknown): Promise<unknown>;
  on(channel: string, callback: (payload: unknown) => void): () => void;
  /** Terminal window only: the port of one local terminal attachment. */
  localTerminalStream?: (attachId: number, handlers: LocalTerminalStreamHandlers) => LocalTerminalStream | null;
}

declare global {
  interface Window {
    operator: OperatorBridgeRaw;
  }
}

export function invoke<C extends InvokeChannel>(
  channel: C,
  payload: InvokeRequest<C>,
): Promise<InvokeResponse<C>> {
  return window.operator.invoke(channel, payload) as Promise<InvokeResponse<C>>;
}

export function onEvent<C extends EventChannel>(
  channel: C,
  callback: (payload: EventPayload<C>) => void,
): () => void {
  return window.operator.on(channel, callback as (payload: unknown) => void);
}
