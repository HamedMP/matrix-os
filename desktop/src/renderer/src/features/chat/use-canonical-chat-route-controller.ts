import type {
  CanonicalChatDetailResponse,
  CanonicalChatRecord,
  CanonicalCreateChatTurnRequest,
} from "@matrix-os/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CanonicalChatClient } from "../../lib/canonical-chat-client";
import { diagnosticErrorKind } from "../../lib/errors";
import { canonicalChatRequestId } from "./canonical-chat-submission";

export type CanonicalChatRouteStatus = "idle" | "loading" | "ready" | "error";

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
  autoSelectFirst = true,
}: {
  client: CanonicalChatClient;
  projectId: string | null;
  active: boolean;
  initialChatId?: string | null;
  autoSelectFirst?: boolean;
}) {
  const [items, setItems] = useState<CanonicalChatRecord[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(initialChatId);
  const [detail, setDetail] = useState<CanonicalChatDetailResponse | null>(null);
  const [status, setStatus] = useState<CanonicalChatRouteStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const activeChatIdRef = useRef<string | null>(initialChatId);
  const routeScopeRef = useRef<{ active: boolean; client: CanonicalChatClient; projectId: string | null } | null>(null);
  const listRequestSequence = useRef(0);
  const detailRequestSequence = useRef(0);

  const loadDetail = useCallback(async (chatId: string) => {
    const sequence = ++detailRequestSequence.current;
    try {
      const loaded = await client.getDetail(chatId, { limit: 200 });
      if (sequence !== detailRequestSequence.current) return;
      setDetail(loaded);
      setError(null);
    } catch (error: unknown) {
      console.warn("[canonical-chat] detail load failed:", diagnosticErrorKind(error));
      if (sequence !== detailRequestSequence.current) return;
      setError("Chat could not be loaded. Try again.");
    }
  }, [client]);

  const load = useCallback(async (query = "") => {
    const sequence = ++listRequestSequence.current;
    setStatus("loading");
    try {
      const page = query.trim()
        ? await client.search(query, { projectId, limit: 100 })
        : await client.list({ projectId, limit: 100 });
      if (sequence !== listRequestSequence.current) return;
      setItems(page.items);
      setError(null);
      setStatus("ready");
      setActiveChatId((current) => {
        const next = current && page.items.some((record) => record.chat.id === current)
          ? current
          : autoSelectFirst ? page.items[0]?.chat.id ?? null : null;
        activeChatIdRef.current = next;
        return next;
      });
      if (page.items.length === 0) setDetail(null);
    } catch (error: unknown) {
      console.warn("[canonical-chat] list load failed:", diagnosticErrorKind(error));
      if (sequence !== listRequestSequence.current) return;
      setStatus("error");
      setError("Chats could not be loaded. Try again.");
    }
  }, [autoSelectFirst, client, projectId]);

  useLayoutEffect(() => {
    const previousScope = routeScopeRef.current;
    const scopeChanged = previousScope?.active !== active
      || previousScope.client !== client
      || previousScope.projectId !== projectId;
    routeScopeRef.current = { active, client, projectId };
    if (!scopeChanged && initialChatId === activeChatIdRef.current) return;
    listRequestSequence.current += 1;
    detailRequestSequence.current += 1;
    setItems([]);
    setDetail(null);
    setActiveChatId(initialChatId);
    activeChatIdRef.current = initialChatId;
    setStatus("idle");
    setError(null);
    if (active) void load();
  }, [active, initialChatId, load, projectId]);

  useEffect(() => {
    if (!active || !activeChatId || detail?.record.chat.id === activeChatId) return;
    void loadDetail(activeChatId);
  }, [active, activeChatId, detail?.record.chat.id, loadDetail]);

  useEffect(() => {
    if (!active || !activeChatId || !detail?.record.activeRun) return;
    const timeout = window.setTimeout(() => void loadDetail(activeChatId), 200);
    return () => window.clearTimeout(timeout);
  }, [active, activeChatId, detail?.record.activeRun, loadDetail]);

  const selectChat = useCallback((chatId: string | null) => {
    detailRequestSequence.current += 1;
    setActiveChatId(chatId);
    activeChatIdRef.current = chatId;
    setDetail(null);
    setError(null);
  }, []);

  const search = useCallback(async (query: string) => {
    await load(query);
  }, [load]);

  const moveProject = useCallback(async (targetProjectId: string | null) => {
    if (!detail) return null;
    const routeScope = routeScopeRef.current;
    const isCurrentScope = () => Boolean(routeScope?.active && routeScopeRef.current === routeScope);
    try {
      const record = await client.updateProject(detail.record.chat.id, {
        baseRevision: detail.record.chat.revision,
        projectId: targetProjectId,
      });
      if (!isCurrentScope()) return null;
      setDetail((current) => current ? detailWithRecord(current, record) : current);
      setItems((current) => current.map((item) => (
        item.chat.id === record.chat.id ? record : item
      )));
      setError(null);
      return record;
    } catch (error: unknown) {
      console.warn("[canonical-chat] project move failed:", diagnosticErrorKind(error));
      if (!isCurrentScope()) return null;
      setError("The Chat could not be moved. Refresh and try again.");
      await loadDetail(detail.record.chat.id);
      return null;
    }
  }, [client, detail, loadDetail]);

  const submitTurn = useCallback(async (
    input: Omit<CanonicalCreateChatTurnRequest, "clientRequestId" | "baseRevision">,
    title: string,
    initialProjectId: string | null = projectId,
  ) => {
    const routeScope = routeScopeRef.current;
    const isCurrentScope = () => Boolean(routeScope?.active && routeScopeRef.current === routeScope);
    if (!isCurrentScope()) return null;
    try {
      let current = detail;
      if (!current) {
        const record = await client.create({
          clientRequestId: canonicalChatRequestId(),
          title,
          ...(initialProjectId === null ? {} : { projectId: initialProjectId }),
          currentSelection: input.selection,
        });
        if (!isCurrentScope()) return null;
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
        clientRequestId: canonicalChatRequestId(),
        baseRevision: current.record.chat.revision,
      });
      if (!isCurrentScope()) return null;
      const next: CanonicalChatDetailResponse = {
        ...current,
        record: admitted.record,
        messages: [...current.messages, admitted.message],
        turns: [...current.turns, admitted.turn],
        runs: [...current.runs, admitted.run],
      };
      setActiveChatId(admitted.record.chat.id);
      activeChatIdRef.current = admitted.record.chat.id;
      setDetail(next);
      setItems((existing) => [
        admitted.record,
        ...existing.filter((item) => item.chat.id !== admitted.record.chat.id),
      ]);
      setError(null);
      return admitted;
    } catch (error: unknown) {
      console.warn("[canonical-chat] submit failed:", diagnosticErrorKind(error));
      if (!isCurrentScope()) return null;
      setError("The message could not be sent. Try again.");
      return null;
    }
  }, [client, detail, projectId]);

  const cancelActiveRun = useCallback(async () => {
    const activeRun = detail?.record.activeRun;
    if (!detail || !activeRun) return;
    const routeScope = routeScopeRef.current;
    const isCurrentScope = () => Boolean(routeScope?.active && routeScopeRef.current === routeScope);
    try {
      await client.cancelRun(detail.record.chat.id, activeRun.runId, {
        clientRequestId: canonicalChatRequestId(),
      });
      if (!isCurrentScope()) return;
      await loadDetail(detail.record.chat.id);
    } catch (error: unknown) {
      console.warn("[canonical-chat] cancel failed:", diagnosticErrorKind(error));
      if (!isCurrentScope()) return;
      setError("The active Run could not be stopped. Try again.");
    }
  }, [client, detail, loadDetail]);

  const deleteChat = useCallback(async (chatId: string) => {
    const routeScope = routeScopeRef.current;
    const isCurrentScope = () => Boolean(routeScope?.active && routeScopeRef.current === routeScope);
    try {
      await client.delete(chatId, canonicalChatRequestId());
      if (!isCurrentScope()) return false;
      setItems((current) => current.filter((item) => item.chat.id !== chatId));
      if (activeChatIdRef.current === chatId) selectChat(null);
      setError(null);
      return true;
    } catch (error: unknown) {
      console.warn("[canonical-chat] delete failed:", diagnosticErrorKind(error));
      if (!isCurrentScope()) return false;
      setError("The Chat could not be deleted. Try again.");
      return false;
    }
  }, [client, selectChat]);

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
    deleteChat,
    startNewChat: () => selectChat(null),
  };
}
