import { useWorkAgentDraftRequest } from "./use-work-agent-draft-request";
import { useCompanyDriveChatHandoff } from "./use-company-drive-chat-handoff";
import { chatEventVersionUrl, chatMessageVersionUrl, chatReadStateVersionUrl } from "@matrix-os/contracts";
import { ChatAgentsWorkspace, type ChatAgentDraftRequest } from "@matrix-os/ui";
import {
  createCanonicalChatClient,
  createCanonicalChatEventSource,
  type CanonicalChatClient,
  type CanonicalChatEventSource,
} from "../../lib/canonical-chat-client";
import { useConnection } from "../../stores/connection";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

interface WorkSurfaceRuntime {
  client: CanonicalChatClient | null;
  eventSource: CanonicalChatEventSource | null;
  projectedChatTitles: CanonicalChatTitleProjection[];
  projectChat: (record: CanonicalChatRecord) => void;
  agentDraftRequest: ChatAgentDraftRequest | null;
  requestAgentDraft: ReturnType<typeof useWorkAgentDraftRequest>["requestAgentDraft"];
  consumeAgentDraft: (id: number) => void;
}

export interface CanonicalChatTitleProjection {
  chatId: string;
  title: string;
  revision: number;
  titleVersion?: number;
}

const MAX_CHAT_TITLE_PROJECTIONS = 100;
const EMPTY_CHAT_TITLE_PROJECTIONS: CanonicalChatTitleProjection[] = [];

const WorkSurfaceRuntimeContext = createContext<WorkSurfaceRuntime | null>(null);

export function WorkSurfaceRuntimeProvider({ active, tabId, children }: { active: boolean; tabId?: string; children: ReactNode }) {
  const api = useConnection((state) => state.api);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const [projection, setProjection] = useState<{
    client: CanonicalChatClient | null;
    titles: CanonicalChatTitleProjection[];
  } | null>(null);
  const pendingDisposalRef = useRef<{ source: CanonicalChatEventSource; cancelled: boolean } | null>(null);
  const client = useMemo(() => api ? createCanonicalChatClient(api) : null, [api, authGeneration, runtimeSlot]);
  const { agentDraftRequest, requestAgentDraft, consumeAgentDraft } = useWorkAgentDraftRequest();
  useCompanyDriveChatHandoff(active,tabId,requestAgentDraft);
  const eventSource = useMemo<CanonicalChatEventSource | null>(() => {
    if (!api || !active) return null;
    return createCanonicalChatEventSource({
      openStream({ cursor, signal }) {
        return api.openStream(chatEventVersionUrl(chatReadStateVersionUrl(chatMessageVersionUrl("/api/chats/events"))), {
          accept: "text/event-stream",
          signal,
          timeoutMs: 5 * 60 * 1000,
          headers: { "x-matrix-chat-protocol": "2", ...(cursor === undefined ? {} : { "last-event-id": String(cursor) }) },
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

  const projectChat = useCallback((record: CanonicalChatRecord) => {
    setProjection((current) => {
      const titles = current?.client === client ? current.titles : [];
      const existing = titles.find((candidate) => candidate.chatId === record.chat.id);
      if (existing && ((existing.titleVersion ?? 0) > (record.chat.titleVersion ?? 0)
        || ((existing.titleVersion ?? 0) === (record.chat.titleVersion ?? 0) && existing.revision > record.chat.revision))) return current;
      return {
        client,
        titles: [
          ...titles.filter((candidate) => candidate.chatId !== record.chat.id),
          { chatId: record.chat.id, title: record.chat.title, titleVersion: record.chat.titleVersion, revision: record.chat.revision },
        ].slice(-MAX_CHAT_TITLE_PROJECTIONS),
      };
    });
  }, [client]);
  const projectedChatTitles = projection?.client === client ? projection.titles : EMPTY_CHAT_TITLE_PROJECTIONS;
  const value = useMemo(
    () => ({ client, eventSource, projectedChatTitles, projectChat, agentDraftRequest, requestAgentDraft, consumeAgentDraft }),
    [client, eventSource, projectChat, projectedChatTitles, agentDraftRequest, requestAgentDraft, consumeAgentDraft],
  );
  return <WorkSurfaceRuntimeContext.Provider value={value}><ChatAgentsWorkspace>{children}</ChatAgentsWorkspace></WorkSurfaceRuntimeContext.Provider>;
}

export function useWorkSurfaceRuntime(): WorkSurfaceRuntime | null {
  return useContext(WorkSurfaceRuntimeContext);
}
