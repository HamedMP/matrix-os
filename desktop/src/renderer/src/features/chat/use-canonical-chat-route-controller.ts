import type {
  CanonicalChatDetailResponse,
  CanonicalChatRecord,
  CanonicalCreateChatTurnRequest,
} from "@matrix-os/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CanonicalChatClient } from "../../lib/canonical-chat-client";

export type CanonicalChatRouteStatus = "idle" | "loading" | "ready" | "error";

function requestId(): string {
  return `req_${crypto.randomUUID().replaceAll("-", "")}`;
}

function detailWithRecord(
  detail: CanonicalChatDetailResponse,
  record: CanonicalChatRecord,
): CanonicalChatDetailResponse {
  return { ...detail, record };
}

export function useCanonicalChatRouteController({
  client,
  projectId,
  active,
  initialChatId = null,
}: {
  client: CanonicalChatClient;
  projectId: string | null;
  active: boolean;
  initialChatId?: string | null;
}) {
  const [items, setItems] = useState<CanonicalChatRecord[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(initialChatId);
  const [detail, setDetail] = useState<CanonicalChatDetailResponse | null>(null);
  const [status, setStatus] = useState<CanonicalChatRouteStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const loadDetail = useCallback(async (chatId: string) => {
    const sequence = ++requestSequence.current;
    try {
      const loaded = await client.getDetail(chatId, { limit: 200 });
      if (sequence !== requestSequence.current) return;
      setDetail(loaded);
      setError(null);
    } catch {
      if (sequence !== requestSequence.current) return;
      setError("Chat could not be loaded. Try again.");
    }
  }, [client]);

  const load = useCallback(async (query = "") => {
    const sequence = ++requestSequence.current;
    setStatus("loading");
    try {
      const page = query.trim()
        ? await client.search(query, { projectId, limit: 100 })
        : await client.list({ projectId, limit: 100 });
      if (sequence !== requestSequence.current) return;
      setItems(page.items);
      setError(null);
      setStatus("ready");
      setActiveChatId((current) => {
        if (current && page.items.some((record) => record.chat.id === current)) return current;
        return page.items[0]?.chat.id ?? null;
      });
      if (page.items.length === 0) setDetail(null);
    } catch {
      if (sequence !== requestSequence.current) return;
      setStatus("error");
      setError("Chats could not be loaded. Try again.");
    }
  }, [client, projectId]);

  useEffect(() => {
    requestSequence.current += 1;
    setItems([]);
    setDetail(null);
    setActiveChatId(initialChatId);
    setStatus("idle");
    setError(null);
    if (active) void load();
  }, [active, initialChatId, load, projectId]);

  useEffect(() => {
    if (!active || !activeChatId) return;
    void loadDetail(activeChatId);
  }, [active, activeChatId, loadDetail]);

  useEffect(() => {
    if (!active || !activeChatId || !detail?.record.activeRun) return;
    const timeout = window.setTimeout(() => void loadDetail(activeChatId), 1_000);
    return () => window.clearTimeout(timeout);
  }, [active, activeChatId, detail?.record.activeRun, loadDetail]);

  const selectChat = useCallback((chatId: string | null) => {
    requestSequence.current += 1;
    setActiveChatId(chatId);
    setDetail(null);
    setError(null);
  }, []);

  const search = useCallback(async (query: string) => {
    await load(query);
  }, [load]);

  const moveProject = useCallback(async (targetProjectId: string | null) => {
    if (!detail) return null;
    try {
      const record = await client.updateProject(detail.record.chat.id, {
        baseRevision: detail.record.chat.revision,
        projectId: targetProjectId,
      });
      setDetail((current) => current ? detailWithRecord(current, record) : current);
      setItems((current) => current.map((item) => (
        item.chat.id === record.chat.id ? record : item
      )));
      setError(null);
      return record;
    } catch {
      setError("The Chat could not be moved. Refresh and try again.");
      await loadDetail(detail.record.chat.id);
      return null;
    }
  }, [client, detail, loadDetail]);

  const submitTurn = useCallback(async (
    input: Omit<CanonicalCreateChatTurnRequest, "clientRequestId" | "baseRevision">,
    title: string,
  ) => {
    try {
      let current = detail;
      if (!current) {
        const record = await client.create({
          clientRequestId: requestId(),
          title,
          ...(projectId === null ? {} : { projectId }),
          currentSelection: input.selection,
        });
        setActiveChatId(record.chat.id);
        current = {
          record,
          messages: [],
          turns: [],
          runs: [],
          activities: [],
        };
      }
      const admitted = await client.admitTurn(current.record.chat.id, {
        ...input,
        clientRequestId: requestId(),
        baseRevision: current.record.chat.revision,
      });
      const next: CanonicalChatDetailResponse = {
        ...current,
        record: admitted.record,
        messages: [...current.messages, admitted.message],
        turns: [...current.turns, admitted.turn],
        runs: [...current.runs, admitted.run],
      };
      setDetail(next);
      setItems((existing) => [
        admitted.record,
        ...existing.filter((item) => item.chat.id !== admitted.record.chat.id),
      ]);
      setError(null);
      return admitted;
    } catch {
      setError("The message could not be sent. Try again.");
      return null;
    }
  }, [client, detail, projectId]);

  const cancelActiveRun = useCallback(async () => {
    const activeRun = detail?.record.activeRun;
    if (!detail || !activeRun) return;
    try {
      await client.cancelRun(detail.record.chat.id, activeRun.runId, {
        clientRequestId: requestId(),
      });
      await loadDetail(detail.record.chat.id);
    } catch {
      setError("The active Run could not be stopped. Try again.");
    }
  }, [client, detail, loadDetail]);

  return {
    items,
    activeChatId,
    detail,
    status,
    error,
    selectChat,
    search,
    refresh: load,
    moveProject,
    submitTurn,
    cancelActiveRun,
    startNewChat: () => selectChat(null),
  };
}
