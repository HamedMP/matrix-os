import {
  createCanonicalChatClient,
  createCanonicalChatEventSource,
  type CanonicalChatClient,
  type CanonicalChatEventSource,
  type DesktopCanonicalChatWebSocket,
} from "../../lib/canonical-chat-client";
import { useConnection } from "../../stores/connection";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

interface WorkSurfaceRuntime {
  client: CanonicalChatClient | null;
  eventSource: CanonicalChatEventSource | null;
  projectedChatTitle: CanonicalChatTitleProjection | null;
  projectChat: (record: CanonicalChatRecord) => void;
}

export interface CanonicalChatTitleProjection {
  chatId: string;
  title: string;
  revision: number;
}

const WorkSurfaceRuntimeContext = createContext<WorkSurfaceRuntime | null>(null);

export function WorkSurfaceRuntimeProvider({ active, children }: { active: boolean; children: ReactNode }) {
  const api = useConnection((state) => state.api);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const [projection, setProjection] = useState<{
    client: CanonicalChatClient | null;
    title: CanonicalChatTitleProjection;
  } | null>(null);
  const pendingDisposalRef = useRef<{ source: CanonicalChatEventSource; cancelled: boolean } | null>(null);
  const client = useMemo(() => api ? createCanonicalChatClient(api) : null, [api, authGeneration, runtimeSlot]);
  const eventSource = useMemo<CanonicalChatEventSource | null>(() => {
    if (!api || !active) return null;
    return createCanonicalChatEventSource({
      gatewayOrigin: api.baseUrl,
      runtimeSlot,
      async fetchWebSocketToken() {
        const response = await api.get<{ token?: unknown }>("/api/auth/ws-token");
        if (typeof response.token !== "string") throw new Error("ChatEventCredentialUnavailable");
        return response.token;
      },
      createWebSocket: (url) => new WebSocket(url) as unknown as DesktopCanonicalChatWebSocket,
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

  const projectChat = useCallback((record: CanonicalChatRecord) => {
    setProjection({
      client,
      title: {
        chatId: record.chat.id,
        title: record.chat.title,
        revision: record.chat.revision,
      },
    });
  }, [client]);
  const projectedChatTitle = projection?.client === client ? projection.title : null;
  const value = useMemo(
    () => ({ client, eventSource, projectedChatTitle, projectChat }),
    [client, eventSource, projectChat, projectedChatTitle],
  );
  return <WorkSurfaceRuntimeContext.Provider value={value}>{children}</WorkSurfaceRuntimeContext.Provider>;
}

export function useWorkSurfaceRuntime(): WorkSurfaceRuntime | null {
  return useContext(WorkSurfaceRuntimeContext);
}
