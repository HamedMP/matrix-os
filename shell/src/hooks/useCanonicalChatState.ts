"use client";

import {
  generatedChatTitle,
  mergeCanonicalChatRecord,
  mergeChatReadState,
  sharedChatMembershipFromProjection,
  type ChatCollaborationView,
} from "@matrix-os/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CollaborationIdSchema,
  type CanonicalChatMessagePart,
  type CanonicalChatApprovalDecision,
  type CanonicalSubmitChatInputRequest,
  type CanonicalChatDetailResponse,
  type CanonicalChatRecord,
} from "@matrix-os/contracts";
import {
  createChatMentionRequestTracker,
  createSharedCanonicalChatEventSource,
  createCanonicalChatRefresh,
  applyCanonicalChatContent,
  type CanonicalChatEventConnectionState,
} from "@matrix-os/ui";
import { useSocket } from "@/hooks/useSocket";
import type { ChatState, ChatSubmitOptions } from "@/hooks/useChatState";
import { getGatewayUrl } from "@/lib/gateway";
import {
  createCanonicalShellChatClient,
  isDefinitiveCanonicalChatRejection,
} from "@/lib/canonical-chat-client";
import { projectCanonicalTranscript } from "@/lib/canonical-chat-terminal-notices";

const ACTIVE_RUN_FALLBACK_POLL_MS = 2_000;
const EVENT_INVALIDATION_COALESCE_MS = 200;

function requestId(): string {
  return `req_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

function conversationMeta(record: CanonicalChatRecord) {
  return {
    readState: record.readState,
    id: record.chat.id,
    title: record.chat.title,
    preview: record.chat.lastMessagePreview ?? record.chat.title,
    messageCount: record.chat.messageCount,
    createdAt: Date.parse(record.chat.createdAt),
    updatedAt: Date.parse(record.chat.activityAt ?? record.chat.createdAt),
  };
}

function collaborationViewFromPathname(pathname: string): ChatCollaborationView | null {
  if (pathname === "/shared" || pathname === "/shared/") return { kind: "home" };
  const match = /^\/shared\/chat\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  const scopeId = CollaborationIdSchema.safeParse(match[1]);
  return scopeId.success ? { kind: "chat", scopeId: scopeId.data } : null;
}

function pushShellChatPath(pathname: string): void {
  if (typeof window !== "undefined" && window.location.pathname !== pathname) {
    window.history.pushState(null, "", pathname);
  }
}

function leaveSharedChatPath(): void {
  if (typeof window !== "undefined" && /^\/shared(?:\/|$)/.test(window.location.pathname)) {
    window.history.pushState(null, "", "/");
  }
}

export function useCanonicalChatState({ initialDraft, initialCollaborationView }: {
  initialDraft?: string | null;
  initialCollaborationView?: ChatCollaborationView;
} = {}): ChatState {
  const [mentionRequests] = useState(createChatMentionRequestTracker);
  const client = useMemo(() => createCanonicalShellChatClient({ gatewayUrl: getGatewayUrl() }), []);
  const eventSource = useMemo(() => createSharedCanonicalChatEventSource({
    openStream: (input) => client.openEventStream(input),
  }), [client]);
  const { connected } = useSocket();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [records, setRecords] = useState<CanonicalChatRecord[]>([]);
  const recordsRef = useRef(records);
  useEffect(() => { recordsRef.current = records; }, [records]);
  const [activeChatId, setActiveChatId] = useState<string>();
  const [selectedCollaborationView, setSelectedCollaborationView] = useState<ChatCollaborationView | null>(
    initialCollaborationView ?? null,
  );
  const [detail, setDetail] = useState<CanonicalChatDetailResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [safeError, setSafeError] = useState<string | null>(null);
  const [eventConnectionState, setEventConnectionState] = useState<CanonicalChatEventConnectionState>(
    eventSource.connectionState(),
  );
  const [composerDraftRequest, setComposerDraftRequest] = useState<{ id: number; text: string } | null>(null);
  // One active input attempt per hook; bounded and retained for ambiguous retries.
  const inputAttempt = useRef<{ key: string; clientRequestId: string; inFlight: boolean } | null>(null);
  const composerDraftSequence = useRef(0);
  const detailRequestGeneration = useRef(0);
  const pendingEventSourceDisposalRef = useRef<{
    source: typeof eventSource;
    cancelled: boolean;
  } | null>(null);
  const detailRef = useRef(detail);
  const activeChatIdRef = useRef(activeChatId);
  // An empty selection after New chat is intentional, not an initial restore.
  const autoRestoreChatRef = useRef(true);
  const initialDraftConsumed = useRef(false);
  detailRef.current = detail;
  activeChatIdRef.current = activeChatId;

  useEffect(() => {
    const synchronizeFromHistory = () => {
      const view = collaborationViewFromPathname(window.location.pathname);
      if (view) {
        autoRestoreChatRef.current = false;
        activeChatIdRef.current = undefined;
        detailRef.current = null;
        detailRequestGeneration.current += 1;
        setActiveChatId(undefined);
        setDetail(null);
        setSafeError(null);
      }
      setSelectedCollaborationView(view);
    };
    window.addEventListener("popstate", synchronizeFromHistory);
    return () => window.removeEventListener("popstate", synchronizeFromHistory);
  }, []);

  useEffect(() => {
    if (!initialDraft || initialDraftConsumed.current) return;
    initialDraftConsumed.current = true;
    autoRestoreChatRef.current = false;
    activeChatIdRef.current = undefined;
    detailRef.current = null;
    detailRequestGeneration.current += 1;
    setActiveChatId(undefined);
    setDetail(null);
    setComposerDraftRequest({ id: ++composerDraftSequence.current, text: initialDraft });
  }, [initialDraft]);

  const listGeneration = useRef(0);
  const loadList = useCallback(async () => {
    const generation = ++listGeneration.current;
    try {
      const loaded: CanonicalChatRecord[] = [];
      let cursor: string | undefined;
      // Match the Work Rail's bounded 1,000-chat window, following server cursors.
      for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
        const page = await client.list({ ...(unreadOnly ? { unreadOnly: true } : {}), ...(cursor ? { cursor } : {}) });
        if (listGeneration.current !== generation) return;
        loaded.push(...page.items);
        if (!page.nextCursor || page.nextCursor === cursor) break;
        cursor = page.nextCursor;
      }
      setRecords((current) => loaded.map((record) => {
        const previous = current.find((item) => item.chat.id === record.chat.id);
        return previous ? mergeCanonicalChatRecord(previous, record) : record;
      }));
      if (autoRestoreChatRef.current) {
        setActiveChatId((current) => current ?? loaded[0]?.chat.id);
      }
    } catch (error: unknown) {
      if (listGeneration.current !== generation) return;
      console.warn("[canonical-chat] Shell list unavailable:", error instanceof Error ? error.name : "UnknownError");
      setSafeError("Chats could not be loaded. Try again.");
    }
  }, [client, unreadOnly]);

  const loadDetail = useCallback(async (chatId: string) => {
    const generation = ++detailRequestGeneration.current;
    try {
      let value = await client.detail(chatId);
      if (activeChatIdRef.current !== chatId || detailRequestGeneration.current !== generation) {
        return null;
      }
      const current = detailRef.current;
      if (current?.record.chat.id === chatId
        && current.record.chat.revision > value.record.chat.revision) {
        return current;
      }
      const known = recordsRef.current.find((item) => item.chat.id === chatId);
      const merged = known ? mergeCanonicalChatRecord(known, value.record) : value.record;
      const titleRecord = current?.record.chat.id === chatId
        ? mergeCanonicalChatRecord(current.record, merged) : merged;
      value = { ...value, record: { ...value.record, chat: { ...value.record.chat,
        title: titleRecord.chat.title, titleVersion: titleRecord.chat.titleVersion,
      } } };
      if (current) value = { ...value, record: mergeChatReadState(value.record, current.record) };
      detailRef.current = value;
      setDetail(value);
      setSafeError(null);
      return value;
    } catch (error: unknown) {
      if (activeChatIdRef.current !== chatId || detailRequestGeneration.current !== generation) {
        return null;
      }
      console.warn("[canonical-chat] Shell detail unavailable:", error instanceof Error ? error.name : "UnknownError");
      setSafeError("Chat could not be loaded. Try again.");
      return null;
    }
  }, [client]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    const pendingDisposal = pendingEventSourceDisposalRef.current;
    if (pendingDisposal?.source === eventSource) {
      pendingDisposal.cancelled = true;
      pendingEventSourceDisposalRef.current = null;
    }
    const stateSubscription = eventSource.subscribeConnectionState(() => {
      setEventConnectionState(eventSource.connectionState());
    });
    void eventSource.start();
    return () => {
      stateSubscription.dispose();
      const disposal = { source: eventSource, cancelled: false };
      pendingEventSourceDisposalRef.current = disposal;
      queueMicrotask(() => {
        if (!disposal.cancelled) disposal.source.dispose();
        if (pendingEventSourceDisposalRef.current === disposal) {
          pendingEventSourceDisposalRef.current = null;
        }
      });
    };
  }, [eventSource]);

  useEffect(() => {
    const selectedRefresh = createCanonicalChatRefresh(async () => (
      !activeChatId || Boolean(await loadDetail(activeChatId))
    ));
    let listTimer: number | undefined;
    const subscription = eventSource.subscribe((event) => {
      if (event.type === "chat.changed" && event.content) {
        const record = event.content.content.record;
        setRecords((current) => current.map((item) => item.chat.id === record.chat.id
          ? mergeCanonicalChatRecord(item, record) : item));
        if (event.chatId === activeChatId) {
          const current = detailRef.current;
          const next = current ? applyCanonicalChatContent(current, event.content) : null;
          if (next) {
            detailRef.current = next;
            setDetail(next);
            setSafeError(null);
          } else selectedRefresh.schedule();
        }
        if (event.eventType === "chat.created" || event.eventType === "chat.updated") void loadList();
        return;
      }
      if (event.type === "chat.full_refresh" || event.chatId === activeChatId) {
        selectedRefresh.schedule(EVENT_INVALIDATION_COALESCE_MS);
      }
      // Token/message deltas affect the selected transcript, not the work rail.
      if (event.type === "chat.full_refresh" || event.eventType !== "run.message") {
        if (listTimer !== undefined) return;
        listTimer = window.setTimeout(() => {
          listTimer = undefined;
          void loadList();
        }, EVENT_INVALIDATION_COALESCE_MS);
      }
    });
    return () => {
      subscription.dispose();
      selectedRefresh.dispose();
      if (listTimer !== undefined) window.clearTimeout(listTimer);
    };
  }, [activeChatId, eventSource, loadDetail, loadList]);

  useEffect(() => {
    let cancelled = false;
    let refreshing = false;
    let pending = false;
    const refreshVisible = async () => {
      if (refreshing) {
        pending = true;
        return;
      }
      refreshing = true;
      do {
        pending = false;
        const selectedChatId = activeChatIdRef.current;
        await Promise.all([
          loadList(),
          ...(selectedChatId ? [loadDetail(selectedChatId)] : []),
        ]);
      } while (!cancelled && pending);
      refreshing = false;
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refreshVisible();
    };
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [loadDetail, loadList]);

  useEffect(() => {
    if (!activeChatId) {
      setDetail(null);
      return;
    }
    void loadDetail(activeChatId);
  }, [activeChatId, loadDetail]);

  useEffect(() => {
    if (!activeChatId || !detail?.record.activeRun || eventConnectionState === "open") return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = () => {
      timer = window.setTimeout(async () => {
        await loadDetail(activeChatId);
        if (!cancelled) poll();
      }, ACTIVE_RUN_FALLBACK_POLL_MS);
    };
    poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeChatId, Boolean(detail?.record.activeRun), eventConnectionState, loadDetail]);

  const submitMessage = useCallback(async (
    text: string,
    files?: Array<{ name: string; type: string; data: string }>,
    options?: ChatSubmitOptions,
  ) => {
    if ((!text.trim() && !options?.resources?.length && !files?.length) || submittingRef.current) return false;
    if (activeChatId && detailRef.current?.record.chat.id !== activeChatId) {
      setSafeError("Wait for this chat to finish loading.");
      return false;
    }
    if (!options?.instanceId || !options.model || !options.interactionMode || !options.permissionMode) {
      setSafeError("Choose an available harness and model.");
      return false;
    }
    submittingRef.current = true;
    const sourceChatId = activeChatId;
    setSubmitting(true);
    setSafeError(null);
    const send = async () => {
      const uploadedReferences: string[] = [];
      let turnAdmitted = false;
      let admissionAttempted = false;
      try {
        const selection = {
          instanceId: options.instanceId!,
          model: options.model!,
          ...(options.modelOptions && options.modelOptions.length > 0
            ? { options: options.modelOptions }
            : {}),
        };
        let record = detailRef.current?.record ?? null;
        if (!record) {
          autoRestoreChatRef.current = false;
          record = await client.create({
            clientRequestId: options.clientRequestId ? `${options.clientRequestId}_chat` : requestId(),
            title: generatedChatTitle(options.displayText?.trim() || text),
            currentSelection: selection,
          });
        }
        if ((files?.length ?? 0) > 8) throw new Error("TooManyAttachments");
        const uploadResults = await Promise.allSettled((files ?? []).map(async (file, index) => {
          const retryKey = options.resources?.length && options.clientRequestId
            ? `${options.clientRequestId}:${index}` : undefined;
          const reference = await client.uploadAttachment(file, retryKey);
          if (!reference.ownerReference) throw new Error("InvalidAttachmentReference");
          uploadedReferences.push(reference.ownerReference);
          return reference;
        }));
        const failedUpload = uploadResults.find((result) => result.status === "rejected");
        if (failedUpload?.status === "rejected") throw failedUpload.reason;
        const attachmentParts = uploadResults.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : []);
        admissionAttempted = true;
        const parts: CanonicalChatMessagePart[] = [
          ...(text.trim() ? [{ type: "text" as const, text: options.promptText?.trim() || text.trim() }] : []),
          ...(options.resources ?? []).map((resource) => ({ type: "resource_reference" as const, resource })),
          ...attachmentParts,
        ];
        const input = {
          clientRequestId: options.clientRequestId ?? requestId(), baseRevision: record.chat.revision,
          parts, selection, interactionMode: options.interactionMode!, permissionMode: options.permissionMode!,
        };
        const requestScope = record.chat.id;
        let operation = record.activeRun && options.resources?.length ? "queue" as const : "send" as const;
        if (options.resources?.length) {
          const { clientRequestId: seed, baseRevision: _revision, ...semanticInput } = input;
          const attempt = mentionRequests.resolve(client, requestScope, semanticInput, operation, seed);
          input.clientRequestId = attempt.clientRequestId;
          operation = attempt.operation;
        }
        if (operation === "queue") {
          const queued = await client.queueTurn(record.chat.id, input);
          turnAdmitted = true;
          mentionRequests.accepted(requestScope, input.clientRequestId);
          const current = detailRef.current;
          if (activeChatIdRef.current === record.chat.id && current?.record.chat.id === record.chat.id) {
            const queuedTurns = [...(current.queuedTurns ?? []).filter((row) => row.id !== queued.queuedTurn.id), ...(queued.alreadyClaimed ? [] : [queued.queuedTurn])];
            const next = { ...current, queuedTurns };
            detailRef.current = next;
            setDetail(next);
          }
          await loadDetail(record.chat.id);
          return true;
        }
        const admitted = await client.admitTurn(record.chat.id, input);
        turnAdmitted = true;
        mentionRequests.accepted(requestScope, input.clientRequestId);
        if (activeChatIdRef.current === sourceChatId) {
          activeChatIdRef.current = record.chat.id;
          setActiveChatId(record.chat.id);
          const current = detailRef.current?.record.chat.id === record.chat.id ? detailRef.current : null;
          if (!current || current.record.chat.revision < admitted.record.chat.revision) {
            const next = {
              record: admitted.record,
              messages: [...(current?.messages ?? []), admitted.message],
              turns: [...(current?.turns ?? []), admitted.turn], runs: [...(current?.runs ?? []), admitted.run],
              activities: current?.activities ?? [], queuedTurns: current?.queuedTurns,
            };
            detailRef.current = next;
            setDetail(next);
          }
        }
        await loadList();
        await loadDetail(record.chat.id);
        return true;
      } catch (error: unknown) {
        const definitelyUnadmitted = !admissionAttempted || isDefinitiveCanonicalChatRejection(error);
        if (!turnAdmitted && definitelyUnadmitted && uploadedReferences.length > 0) {
          await Promise.allSettled(uploadedReferences.map((reference) => client.deleteAttachment(reference)));
        }
        console.warn("[canonical-chat] Shell Turn admission failed:", error instanceof Error ? error.name : "UnknownError");
        if (activeChatIdRef.current === sourceChatId) setSafeError("Message could not be sent. Try again.");
        return turnAdmitted;
      }
    };
    return send().finally(() => {
      submittingRef.current = false;
      setSubmitting(false);
    });
  }, [activeChatId, client, loadDetail, loadList, mentionRequests]);

  const cancelQueuedTurn = useCallback(async (queuedTurnId: string) => {
    const current = detailRef.current;
    if (!activeChatId || current?.record.chat.id !== activeChatId) return false;
    try {
      await client.cancelQueuedTurn(activeChatId, queuedTurnId, { clientRequestId: requestId(), baseRevision: current.record.chat.revision });
      await loadDetail(activeChatId);
      return true;
    } catch (error: unknown) {
      console.warn("[canonical-chat] Queue cancellation failed:", error instanceof Error ? error.name : "UnknownError");
      if (activeChatIdRef.current === activeChatId) setSafeError("Queued request could not be cancelled. Try again.");
      return false;
    }
  }, [activeChatId, client, loadDetail]);

  const newChat = useCallback(async () => {
    autoRestoreChatRef.current = false;
    activeChatIdRef.current = undefined;
    detailRef.current = null;
    detailRequestGeneration.current += 1;
    setActiveChatId(undefined);
    setDetail(null);
    setSafeError(null);
    setSelectedCollaborationView(null);
    leaveSharedChatPath();
  }, []);

  const switchConversation = useCallback((chatId: string) => {
    detailRequestGeneration.current += 1;
    setActiveChatId(chatId);
    setDetail(null);
    setSafeError(null);
    setSelectedCollaborationView(null);
    leaveSharedChatPath();
  }, []);

  const openSharedChat = useCallback((scopeId: string) => {
    autoRestoreChatRef.current = false;
    activeChatIdRef.current = undefined;
    detailRef.current = null;
    detailRequestGeneration.current += 1;
    setActiveChatId(undefined);
    setDetail(null);
    setSafeError(null);
    setSelectedCollaborationView({ kind: "chat", scopeId });
    pushShellChatPath(`/shared/chat/${encodeURIComponent(scopeId)}`);
  }, []);

  const abortCurrent = useCallback(() => {
    const current = detailRef.current;
    if (!current?.record.activeRun) return;
    void client.cancelRun(current.record.chat.id, current.record.activeRun.runId, requestId())
      .then(() => loadDetail(current.record.chat.id))
      .catch((error: unknown) => {
        console.warn("[canonical-chat] Shell cancellation failed:", error instanceof Error ? error.name : "UnknownError");
        setSafeError("The run could not be stopped. Try again.");
      });
  }, [client, loadDetail]);

  const submitInput = useCallback(async (
    runId: string,
    inputRequestId: string,
    input: Omit<CanonicalSubmitChatInputRequest, "clientRequestId">,
  ) => {
    const current = detailRef.current;
    if (!current?.record.activeRun || current.record.chat.id !== activeChatIdRef.current
      || current.record.activeRun.runId !== runId || inputAttempt.current?.inFlight) return false;
    const chatId = current.record.chat.id;
    // Retry identity never contains answers, including secret text.
    const key = JSON.stringify([chatId, runId, inputRequestId]);
    const attempt = inputAttempt.current?.key === key
      ? inputAttempt.current : { key, clientRequestId: requestId(), inFlight: false };
    inputAttempt.current = attempt;
    attempt.inFlight = true;
    try {
      await client.submitInput(chatId, runId, inputRequestId, { ...input, clientRequestId: attempt.clientRequestId });
      if (activeChatIdRef.current === chatId) await loadDetail(chatId);
      return true;
    } catch (error: unknown) {
      console.warn("[canonical-chat] Shell input submission failed:", error instanceof Error ? error.name : "UnknownError");
      if (activeChatIdRef.current === chatId) await loadDetail(chatId);
      if (activeChatIdRef.current === chatId) setSafeError("Your answer could not be submitted. Try again.");
      return false;
    } finally {
      attempt.inFlight = false;
    }
  }, [client, loadDetail]);

  const submitApproval = useCallback(async (
    runId: string,
    approvalId: string,
    decision: CanonicalChatApprovalDecision,
  ) => {
    const current = detailRef.current;
    if (!current?.record.activeRun || current.record.chat.id !== activeChatIdRef.current
      || current.record.activeRun.runId !== runId) {
      setSafeError("The approval could not be submitted. Refresh and try again.");
      return false;
    }
    try {
      await client.submitApproval(
        current.record.chat.id,
        runId,
        approvalId,
        decision,
        requestId(),
      );
      await loadDetail(current.record.chat.id);
      return true;
    } catch (error: unknown) {
      console.warn("[canonical-chat] Shell approval failed:", error instanceof Error ? error.name : "UnknownError");
      setSafeError("The approval could not be submitted. Refresh and try again.");
      await loadDetail(current.record.chat.id);
      return false;
    }
  }, [client, loadDetail]);

  const renameConversation = useCallback(async (chatId: string, title: string) => {
    const current = detailRef.current?.record.chat.id === chatId
      ? detailRef.current.record
      : records.find((record) => record.chat.id === chatId);
    if (!current) {
      setSafeError("The Chat could not be renamed. Refresh and try again.");
      return false;
    }
    try {
      const updated = await client.updateTitle(chatId, {
        expectedTitleVersion: current.chat.titleVersion ?? 0,
        title,
      });
      setRecords((existing) => existing.map((record) => record.chat.id === chatId
        ? mergeCanonicalChatRecord(record, updated) : record));
      const active = detailRef.current;
      if (active?.record.chat.id === chatId) {
        const merged = mergeCanonicalChatRecord(active.record, updated);
        const next = { ...active, record: { ...active.record, chat: { ...active.record.chat,
          title: merged.chat.title, titleVersion: merged.chat.titleVersion,
        } } };
        detailRef.current = next;
        setDetail(next);
      }
      setSafeError(null);
      return true;
    } catch (error: unknown) {
      console.warn("[canonical-chat] Shell rename failed:", error instanceof Error ? error.name : "UnknownError");
      await loadList();
      await loadDetail(chatId);
      setSafeError("The Chat could not be renamed. Try again.");
      return false;
    }
  }, [client, records, loadList, loadDetail]);

  const updateReadState = useCallback(async (chatId: string, input: import("@matrix-os/contracts").CanonicalUpdateChatReadStateRequest) => {
    try {
      const response = await client.updateReadState(chatId, input);
      setRecords((current) => current.map((record) => mergeChatReadState(record, response)));
      const current = detailRef.current;
      if (current?.record.chat.id === chatId) {
        const next = { ...current, record: mergeChatReadState(current.record, response) };
        detailRef.current = next;
        setDetail(next);
      }
      return true;
    } catch (error: unknown) {
      console.warn("[chat] Read state update failed:", error instanceof Error ? error.name : "UnknownError");
      setSafeError("The Chat could not be updated. Try again.");
      return false;
    }
  }, [client]);

  const messages = detail ? projectCanonicalTranscript(detail) : [];
  if (safeError) {
    messages.push({ id: "canonical-safe-error", role: "system", content: safeError, timestamp: Date.now() });
  }
  const activeRecord = detail && detail.record.chat.id === activeChatId
    ? detail.record
    : records.find((record) => record.chat.id === activeChatId);
  const detailLoading = activeChatId !== undefined && detail?.record.chat.id !== activeChatId;
  const projectedSharedChat = sharedChatMembershipFromProjection(activeRecord?.chat.collaboration);
  const collaborationView = selectedCollaborationView
    ?? (projectedSharedChat && activeRecord
      ? { kind: "canonical-chat" as const, chatId: activeRecord.chat.id }
      : undefined);
  return {
    collaborationView,
    openSharedChat,
    unreadOnly, setUnreadOnly,
    readState: detail?.record.chat.id === activeChatId ? detail?.record.readState : undefined,
    displayedThroughSeq: Math.max(0, ...(detail?.messages ?? []).filter((message) => message.role === "assistant" && message.state === "committed").map((message) => message.seq)),
    updateReadState,
    messages,
    sessionId: activeChatId,
    busy: submitting || detailLoading || Boolean(detail?.record.activeRun),
    currentTool: null,
    connected,
    queue: [],
    agentClient: client.agents,
    queuedTurns: detail?.queuedTurns ?? [],
    cancelQueuedTurn,
    providerSelection: activeRecord?.chat.currentSelection,
    boundProviderInstanceId: activeRecord?.providerBinding?.instanceId,
    conversations: records.map(conversationMeta),
    activeConversationTitle: activeRecord?.chat.title,
    renameConversation,
    composerDraftRequest,
    requestComposerDraft: (text) => setComposerDraftRequest({ id: ++composerDraftSequence.current, text }),
    consumeComposerDraft: (id) => setComposerDraftRequest((current) => current?.id === id ? null : current),
    submitMessage,
    newChat,
    switchConversation,
    abortCurrent,
    submitApproval,
    submitInput,
  };
}
