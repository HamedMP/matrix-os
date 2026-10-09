import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

interface NativeCloseBridge {
  onCloseRequest(listener: (request: { requestId: string; type: "request" | "cancel" }) => void): () => void;
  respondToClose(requestId: string, allow: boolean): Promise<unknown>;
}

/** The sandbox sends only a fixed boolean; no user input crosses this bridge. */
export function useWorkspaceCloseGuard(dirty: boolean) {
  const [nativeClosePending, setNativeClosePending] = useState(false);
  const pending = useRef<string | null>(null);
  const bridge = useRef<NativeCloseBridge | null>(null);
  const finishNativeClose = useCallback((allow: boolean) => {
    const requestId = pending.current;
    pending.current = null;
    setNativeClosePending(false);
    if (!requestId || !bridge.current) return;
    void bridge.current.respondToClose(requestId, allow).catch((error: unknown) => {
      console.warn("[utilities-close] response unavailable", error instanceof Error ? "Error" : "UnknownError");
    });
  }, []);
  useLayoutEffect(() => {
    const native = (window as unknown as { MatrixOS?: { utilitiesClose?: NativeCloseBridge } }).MatrixOS?.utilitiesClose;
    if (!native) return;
    bridge.current = native;
    return native.onCloseRequest(request => {
      if (request.type === "cancel") {
        if (pending.current === request.requestId) { pending.current = null; setNativeClosePending(false); }
        return;
      }
      pending.current = request.requestId;
      if (!dirty) finishNativeClose(true);
      else setNativeClosePending(true);
    });
  }, [dirty, finishNativeClose]);
  useEffect(() => () => {
    const requestId = pending.current;
    pending.current = null;
    if (requestId && bridge.current) void bridge.current.respondToClose(requestId, false).catch((error: unknown) => {
      console.warn("[utilities-close] cleanup response unavailable", error instanceof Error ? "Error" : "UnknownError");
    });
  }, []);
  useEffect(() => {
    window.parent.postMessage({ type: "matrix-os:utilities-workspace-state", app: "utilities", dirty }, "*");
  }, [dirty]);
  return { nativeClosePending, finishNativeClose };
}
