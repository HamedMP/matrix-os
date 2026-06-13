// Typed access to the preload bridge. All payloads are re-validated in the
// preload and in main; this wrapper provides compile-time types.
import type {
  EventChannel,
  EventPayload,
  InvokeChannel,
  InvokeRequest,
  InvokeResponse,
} from "../../../shared/ipc-contract";

interface OperatorBridgeRaw {
  invoke(channel: string, payload: unknown): Promise<unknown>;
  on(channel: string, callback: (payload: unknown) => void): () => void;
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
