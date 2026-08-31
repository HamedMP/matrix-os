import type {
  CanonicalChatDetailResponse,
  CanonicalChatApprovalDecision,
  CanonicalChatRecord,
  CanonicalCreateChatTurnRequest,
} from "@matrix-os/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  CanonicalChatClient,
  CanonicalChatEventConsumer,
} from "../../lib/canonical-chat-client";
import { diagnosticErrorKind } from "../../lib/errors";
import { canonicalChatSubmitFailureMessage } from "./canonical-chat-submit-error";
import { canonicalChatRequestId } from "./canonical-chat-submission";

export type CanonicalChatRouteStatus = "idle" | "loading" | "ready" | "error";
const INITIAL_DETAIL_RETRY_MS = 200;
const INITIAL_DETAIL_MAX_RETRY_MS = 2_000;
const ACTIVE_RUN_FALLBACK_POLL_MS = 2_000;
const ACTIVE_RUN_FALLBACK_MAX_RETRY_MS = 10_000;
const STREAM_MESSAGE_REFRESH_COALESCE_MS = 200;

function detailWithRecord(
  detail: CanonicalChatDetailResponse,
  record: CanonicalChatRecord,
): CanonicalChatDetailResponse {
  return { ...detail, record };
}

function shouldApplyAcknowledgement(
  current: CanonicalChatRecord,
  response: CanonicalChatRecord,
  acknowledgedRunId: string,
): boolean {
  if (response.chat.id !== current.chat.id) return false;
  const currentCompletion = current.latestSuccessfulCompletion;
  const responseCompletion = response.latestSuccessfulCompletion;
  const responseHasStrictlyNewerCompletion = responseCompletion !== undefined
    && (currentCompletion === undefined || responseCompletion.completedAt > currentCompletion.completedAt);
  if (response.chat.revision < current.chat.revision) return false;
  if (responseCompletion?.runId !== acknowledgedRunId && !responseHasStrictlyNewerCompletion) {
    return false;
  }
  if (currentCompletion?.runId !== acknowledgedRunId && !responseHasStrictlyNewerCompletion) {
    return false;
  }
  return true;
}

export function useCanonicalChatRouteController({
  client,
  projectId,
  active,
  initialChatId = null,
  autoSelectFirst = true,
  eventSource,
}: {
  client: CanonicalChatClient;
  projectId: string | null;
  active: boolean;
  initialChatId?: string | null;
  autoSelectFirst?: boolean;
  eventSource?: CanonicalChatEventConsumer;
}) {
  const [items, setItems] = useState<CanonicalChatRecord[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(initialChatId);
  const [detail, setDetail] = useState<CanonicalChatDetailResponse | null>(null);
  const [status, setStatus] = useState<CanonicalChatRouteStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const activeChatIdRef = useRef<string | null>(initialChatId);
  const detailRef = useRef<CanonicalChatDetailResponse | null>(null);
  const routeScopeRef = useRef<{ active: boolean; client: CanonicalChatClient; projectId: string | null } | null>(null);
  const listRequestSequence = useRef(0);
  const detailRequestSequence = useRef(0);
  const acknowledgementAttemptRef = useRef<{
    client: CanonicalChatClient;
    chatId: string;
    runId: string;
  } | null>(null);
  const subscribeConnectionState = useCallback((notify: () => void) => {
    const subscription = eventSource?.subscribeConnectionState?.(notify);
    return () => subscription?.dispose();
  }, [eventSource]);
  const getConnectionState = useCallback(
    () => eventSource?.connectionState?.() ?? "idle",
    [eventSource],
  );
  const eventStreamState = useSyncExternalStore(
    subscribeConnectionState,
    getConnectionState,
    getConnectionState,
  );

  const loadDetail = useCallback(async (chatId: string) => {
    const sequence = ++detailRequestSequence.current;
    try {
      const loaded = await client.getDetail(chatId, { limit: 200 });
      if (sequence !== detailRequestSequence.current) return null;
      const current = detailRef.current;
      if (current?.record.chat.id === loaded.record.chat.id
        && current.record.chat.revision > loaded.record.chat.revision) {
        return current;
      }
      detailRef.current = loaded;
      setDetail(loaded);
      setError(null);
      return loaded;
    } catch (error: unknown) {
      console.warn("[canonical-chat] detail load failed:", diagnosticErrorKind(error));
      if (sequence !== detailRequestSequence.current) return null;
      setError("Chat could not be loaded. Try again.");
      return null;
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
      if (page.items.length === 0) {
        detailRef.current = null;
        setDetail(null);
      }
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
    acknowledgementAttemptRef.current = null;
    setItems([]);
    detailRef.current = null;
    setDetail(null);
    setActiveChatId(initialChatId);
    activeChatIdRef.current = initialChatId;
    setStatus("idle");
    setError(null);
    if (active) void load();
  }, [active, initialChatId, load, projectId]);

  useEffect(() => {
    if (!active || !eventSource) return;
    let current = true;
    let detailRefreshInFlight = false;
    let detailRefreshPending = false;
    let listRefreshInFlight = false;
    let listRefreshPending = false;
    let detailRefreshTimer: number | undefined;
    const refreshSelectedDetail = async () => {
      if (detailRefreshInFlight) {
        detailRefreshPending = true;
        return;
      }
      detailRefreshInFlight = true;
      do {
        detailRefreshPending = false;
        const selectedChatId = activeChatIdRef.current;
        if (selectedChatId) await loadDetail(selectedChatId);
      } while (current && detailRefreshPending);
      detailRefreshInFlight = false;
    };
    const refreshList = async () => {
      if (listRefreshInFlight) {
        listRefreshPending = true;
        return;
      }
      listRefreshInFlight = true;
      do {
        listRefreshPending = false;
        await load();
      } while (current && listRefreshPending);
      listRefreshInFlight = false;
    };
    const scheduleSelectedDetailRefresh = (delay = 0) => {
      if (delay === 0) {
        if (detailRefreshTimer !== undefined) {
          window.clearTimeout(detailRefreshTimer);
          detailRefreshTimer = undefined;
        }
        void refreshSelectedDetail();
        return;
      }
      if (detailRefreshTimer !== undefined) return;
      detailRefreshTimer = window.setTimeout(() => {
        detailRefreshTimer = undefined;
        void refreshSelectedDetail();
      }, delay);
    };
    const subscription = eventSource.subscribe((event) => {
      if (event.type === "chat.full_refresh") {
        void refreshList();
        scheduleSelectedDetailRefresh();
        return;
      }
      if (event.chatId === activeChatIdRef.current) {
        scheduleSelectedDetailRefresh(
          event.eventType === "run.message" ? STREAM_MESSAGE_REFRESH_COALESCE_MS : 0,
        );
      }
    });
    return () => {
      current = false;
      detailRefreshPending = false;
      listRefreshPending = false;
      if (detailRefreshTimer !== undefined) window.clearTimeout(detailRefreshTimer);
      subscription.dispose();
    };
  }, [active, eventSource, load, loadDetail]);

  useEffect(() => {
    if (!active || !activeChatId || detail?.record.chat.id === activeChatId) return;
    let cancelled = false;
    let timeout: number | undefined;
    let consecutiveFailures = 0;
    const loadInitialDetail = async () => {
      const loaded = await loadDetail(activeChatId);
      if (cancelled || loaded) return;
      consecutiveFailures += 1;
      timeout = window.setTimeout(
        () => void loadInitialDetail(),
        Math.min(
          INITIAL_DETAIL_RETRY_MS * (2 ** consecutiveFailures),
          INITIAL_DETAIL_MAX_RETRY_MS,
        ),
      );
    };
    void loadInitialDetail();
    return () => {
      cancelled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [active, activeChatId, detail?.record.chat.id, loadDetail]);

  useEffect(() => {
    const completion = detail?.record.latestSuccessfulCompletion;
    if (!active || !activeChatId || detail?.record.chat.id !== activeChatId || !completion) {
      acknowledgementAttemptRef.current = null;
      return;
    }
    if (!completion.unacknowledged) return;
    const existing = acknowledgementAttemptRef.current;
    if (existing?.client === client
      && existing.chatId === activeChatId
      && existing.runId === completion.runId) {
      return;
    }
    const routeScope = routeScopeRef.current;
    const attempt = { client, chatId: activeChatId, runId: completion.runId };
    acknowledgementAttemptRef.current = attempt;
    void client.acknowledgeCompletion(activeChatId, completion.runId).then((record) => {
      if (!routeScope?.active || routeScopeRef.current !== routeScope
        || activeChatIdRef.current !== attempt.chatId) {
        return;
      }
      const current = detailRef.current;
      if (!current || current.record.chat.id !== attempt.chatId
        || !shouldApplyAcknowledgement(current.record, record, attempt.runId)) {
        return;
      }
      const next = detailWithRecord(current, record);
      detailRef.current = next;
      setDetail(next);
      setItems((items) => items.map((item) => (
        item.chat.id === record.chat.id
          && shouldApplyAcknowledgement(item, record, attempt.runId)
          ? record
          : item
      )));
    }).catch((error: unknown) => {
      console.warn("[canonical-chat] completion acknowledgement failed:", diagnosticErrorKind(error));
      if (acknowledgementAttemptRef.current === attempt) {
        acknowledgementAttemptRef.current = null;
      }
    });
  }, [
    active,
    activeChatId,
    client,
    detail?.record.chat.id,
    detail?.record.latestSuccessfulCompletion?.runId,
    detail?.record.latestSuccessfulCompletion?.unacknowledged,
  ]);

  useEffect(() => {
    if (!active || !activeChatId || !detail?.record.activeRun || eventStreamState === "open") return;
    let cancelled = false;
    let timeout: number | undefined;
    let consecutiveFailures = 0;
    const poll = (delay = ACTIVE_RUN_FALLBACK_POLL_MS) => {
      timeout = window.setTimeout(async () => {
        const loaded = await loadDetail(activeChatId);
        if (cancelled) return;
        if (!loaded) {
          consecutiveFailures += 1;
          poll(Math.min(
            ACTIVE_RUN_FALLBACK_POLL_MS * (2 ** consecutiveFailures),
            ACTIVE_RUN_FALLBACK_MAX_RETRY_MS,
          ));
          return;
        }
        consecutiveFailures = 0;
        if (loaded.record.activeRun) poll();
      }, delay);
    };
    poll();
    return () => {
      cancelled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [active, activeChatId, Boolean(detail?.record.activeRun), eventStreamState, loadDetail]);

  const selectChat = useCallback((chatId: string | null) => {
    detailRequestSequence.current += 1;
    setActiveChatId(chatId);
    activeChatIdRef.current = chatId;
    detailRef.current = null;
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
      setDetail((current) => {
        const next = current ? detailWithRecord(current, record) : current;
        detailRef.current = next;
        return next;
      });
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
      detailRef.current = next;
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
      setError(canonicalChatSubmitFailureMessage(error));
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

  const submitApproval = useCallback(async (
    approvalId: string,
    decision: CanonicalChatApprovalDecision,
  ) => {
    const current = detailRef.current;
    const activeRun = current?.record.activeRun;
    if (!current || !activeRun) return false;
    const routeScope = routeScopeRef.current;
    const isCurrentScope = () => Boolean(routeScope?.active && routeScopeRef.current === routeScope);
    try {
      await client.submitApproval(current.record.chat.id, activeRun.runId, approvalId, {
        clientRequestId: canonicalChatRequestId(),
        decision,
      });
      if (!isCurrentScope()) return false;
      await loadDetail(current.record.chat.id);
      return true;
    } catch (error: unknown) {
      console.warn("[canonical-chat] approval failed:", diagnosticErrorKind(error));
      if (!isCurrentScope()) return false;
      setError("The approval could not be submitted. Refresh and try again.");
      await loadDetail(current.record.chat.id);
      return false;
    }
  }, [client, loadDetail]);

  const retryTurn = useCallback(async (turnId: string) => {
    const current = detailRef.current;
    if (!current || current.record.activeRun) return null;
    const routeScope = routeScopeRef.current;
    const isCurrentScope = () => Boolean(routeScope?.active && routeScopeRef.current === routeScope);
    try {
      const admitted = await client.retryTurn(current.record.chat.id, turnId, {
        clientRequestId: canonicalChatRequestId(),
        baseRevision: current.record.chat.revision,
      });
      if (!isCurrentScope()) return null;
      const existing = detailRef.current;
      if (!existing || existing.record.chat.id !== admitted.record.chat.id) return null;
      const next = {
        ...existing,
        record: admitted.record,
        runs: [
          ...existing.runs.filter((run) => run.id !== admitted.run.id),
          admitted.run,
        ],
      };
      detailRef.current = next;
      setDetail(next);
      setItems((existing) => existing.map((item) => (
        item.chat.id === admitted.record.chat.id ? admitted.record : item
      )));
      setError(null);
      return admitted;
    } catch (error: unknown) {
      console.warn("[canonical-chat] retry failed:", diagnosticErrorKind(error));
      if (!isCurrentScope()) return null;
      setError("The Run could not be retried. Refresh and try again.");
      await loadDetail(current.record.chat.id);
      return null;
    }
  }, [client, loadDetail]);

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
    submitApproval,
    retryTurn,
    deleteChat,
    startNewChat: () => selectChat(null),
  };
}
