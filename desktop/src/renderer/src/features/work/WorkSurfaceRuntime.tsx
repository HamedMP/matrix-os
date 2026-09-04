import {
  createCanonicalChatClient,
  createCanonicalChatEventSource,
  type CanonicalChatClient,
  type CanonicalChatEventSource,
} from "../../lib/canonical-chat-client";
import { useConnection } from "../../stores/connection";
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";

interface WorkSurfaceRuntime {
  client: CanonicalChatClient | null;
  eventSource: CanonicalChatEventSource | null;
}

const WorkSurfaceRuntimeContext = createContext<WorkSurfaceRuntime | null>(null);

export function WorkSurfaceRuntimeProvider({ active, children }: { active: boolean; children: ReactNode }) {
  const api = useConnection((state) => state.api);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const pendingDisposalRef = useRef<{ source: CanonicalChatEventSource; cancelled: boolean } | null>(null);
  const client = useMemo(() => api ? createCanonicalChatClient(api) : null, [api, authGeneration, runtimeSlot]);
  const eventSource = useMemo<CanonicalChatEventSource | null>(() => {
    if (!api || !active) return null;
    return createCanonicalChatEventSource({
      openStream({ cursor, signal }) {
        return api.openStream("/api/chats/events", {
          accept: "text/event-stream",
          signal,
          timeoutMs: 5 * 60 * 1000,
          ...(cursor === undefined ? {} : { headers: { "last-event-id": String(cursor) } }),
        });
      },
    });
  }, [active, api, authGeneration, runtimeSlot]);

  useEffect(() => {
    const pendingDisposal = pendingDisposalRef.current;
    if (pendingDisposal?.source === eventSource) {
      pendingDisposal.cancelled = true;
      pendingDisposalRef.current = null;
    }
    if (!eventSource) return;
    void eventSource.start();
    return () => {
      const disposal = { source: eventSource, cancelled: false };
      pendingDisposalRef.current = disposal;
      queueMicrotask(() => {
        if (!disposal.cancelled) disposal.source.dispose();
        if (pendingDisposalRef.current === disposal) pendingDisposalRef.current = null;
      });
    };
  }, [eventSource]);

  const value = useMemo(() => ({ client, eventSource }), [client, eventSource]);
  return <WorkSurfaceRuntimeContext.Provider value={value}>{children}</WorkSurfaceRuntimeContext.Provider>;
}

export function useWorkSurfaceRuntime(): WorkSurfaceRuntime | null {
  return useContext(WorkSurfaceRuntimeContext);
}
