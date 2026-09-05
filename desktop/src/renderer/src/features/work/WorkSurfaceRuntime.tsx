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
  projectedChatTitles: CanonicalChatTitleProjection[];
  projectChat: (record: CanonicalChatRecord) => void;
}

export interface CanonicalChatTitleProjection {
  chatId: string;
  title: string;
  revision: number;
}

const MAX_CHAT_TITLE_PROJECTIONS = 100;
const EMPTY_CHAT_TITLE_PROJECTIONS: CanonicalChatTitleProjection[] = [];

const WorkSurfaceRuntimeContext = createContext<WorkSurfaceRuntime | null>(null);

export function WorkSurfaceRuntimeProvider({ active, children }: { active: boolean; children: ReactNode }) {
  const api = useConnection((state) => state.api);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const [projection, setProjection] = useState<{
    client: CanonicalChatClient | null;
    titles: CanonicalChatTitleProjection[];
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
    setProjection((current) => {
      const titles = current?.client === client ? current.titles : [];
      const existing = titles.find((candidate) => candidate.chatId === record.chat.id);
      if (existing && existing.revision > record.chat.revision) return current;
      return {
        client,
        titles: [
          ...titles.filter((candidate) => candidate.chatId !== record.chat.id),
          { chatId: record.chat.id, title: record.chat.title, revision: record.chat.revision },
        ].slice(-MAX_CHAT_TITLE_PROJECTIONS),
      };
    });
  }, [client]);
  const projectedChatTitles = projection?.client === client ? projection.titles : EMPTY_CHAT_TITLE_PROJECTIONS;
  const value = useMemo(
    () => ({ client, eventSource, projectedChatTitles, projectChat }),
    [client, eventSource, projectChat, projectedChatTitles],
  );
  return <WorkSurfaceRuntimeContext.Provider value={value}>{children}</WorkSurfaceRuntimeContext.Provider>;
}

export function useWorkSurfaceRuntime(): WorkSurfaceRuntime | null {
  return useContext(WorkSurfaceRuntimeContext);
}
