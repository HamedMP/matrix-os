"use client";

import {
  generatedChatTitle,
  mergeCanonicalChatRecord,
  mergeChatNavigationRecord,
  type ChatNavigationRecord,
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
  canonicalChatApprovals,
} from "@matrix-os/contracts";
import {
  createChatMentionRequestTracker,
  createSharedCanonicalChatEventSource,
  createCanonicalChatRefresh,
  applyCanonicalChatContent,
  type CanonicalChatEventConnectionState,
} from "@matrix-os/ui";
import { useShellChatNavigation } from "./useChatNavigation";
import { useUnreadChatNavigation } from "./useUnreadChatNavigation";
import { useCanonicalChatAuthority } from "./useCanonicalChatAuthority";
import { useCanonicalChatSelection } from "./useCanonicalChatSelection";
import { useSocket } from "@/hooks/useSocket";
import type { ChatState, ChatSubmitOptions } from "@/hooks/useChatState";
import { getGatewayUrl } from "@/lib/gateway";
import {
  CanonicalShellChatRequestError,
  createCanonicalShellChatClient,
  canonicalShellChatFailureMessage,
  isDefinitiveCanonicalChatRejection,
} from "@/lib/canonical-chat-client";
import { projectCanonicalTranscript } from "@/lib/canonical-chat-terminal-notices";

const ACTIVE_RUN_FALLBACK_POLL_MS = 2_000;
const EVENT_INVALIDATION_COALESCE_MS = 200;

function requestId(): string {
  return `req_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

function conversationMeta(record: ChatNavigationRecord) {
  return {
    canonicalRecord: record,
    readState: record.readState,
    id: record.chat.id,
    title: record.chat.title,
    preview: record.chat.title,
    messageCount: record.chat.messageCount,
    createdAt: Date.parse(record.chat.createdAt),
    updatedAt: Date.parse(record.chat.activityAt ?? record.chat.createdAt),
  };
}

function collaborationViewFromPathname(pathname: string): ChatCollaborationView | null {
  if (pathname === "/shared" || pathname === "/shared/") return { kind: "home" };
  const match = /^\/shared\/(chat|project)\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  const scopeId = CollaborationIdSchema.safeParse(match[2]);
  if (!scopeId.success) return null;
  return match[1] === "project" ? { kind: "project", scopeId: scopeId.data } : { kind: "chat", scopeId: scopeId.data };
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

export function useCanonicalChatState({ initialDraft, initialCollaborationView, navigationScope,navigationGeneration }: {
  initialDraft?: string | null;
  navigationScope?:string;
  navigationGeneration?:string;
  initialCollaborationView?: ChatCollaborationView;
} = {}): ChatState {
  const [mentionRequests] = useState(createChatMentionRequestTracker);
  const client = useMemo(() => createCanonicalShellChatClient({ gatewayUrl: getGatewayUrl() }), []);
  const eventSource = useMemo(() => createSharedCanonicalChatEventSource({
    openStream: (input) => client.openEventStream(input),
  }), [client]);
  const { connected } = useSocket();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const navigation = useShellChatNavigation(client, eventSource, navigationScope, navigationGeneration);
  const authority = useCanonicalChatAuthority(navigation, client.agents, navigationScope, navigationGeneration);
  const { isCurrent } = authority;
  const composerIdentity = useMemo(() => ({ client, scope: navigationScope }), [client, navigationScope]);
  const unreadNavigation = useUnreadChatNavigation(client, navigation, unreadOnly);
  const { records, update: updateUnreadRecords, refresh: refreshUnread } = unreadNavigation;
  const setRecords = useCallback((update: (records: ChatNavigationRecord[]) => ChatNavigationRecord[], invalidateUnread = true) => {
    if (!isCurrent()) return;
    updateUnreadRecords(update, invalidateUnread);
    // Streaming patches use the non-invalidating store path at the event boundary;
    // durable changes reconcile membership and fence older list responses.
    if (!invalidateUnread) return;
    navigation.store?.update(current => {
      const updated = update(current);
      if (updated === current) return current;
      return updated.flatMap(record => {
        const known = current.find(item => item.chat.id === record.chat.id);
        return known ? [mergeChatNavigationRecord(known, record)] : [];
      });
    });
  }, [navigation.store, updateUnreadRecords, isCurrent]);
  const recordsRef = useRef(records);
  useEffect(() => { recordsRef.current = records; }, [records]);
  const navigationIdentity = authority.identity;
  const [detailError, setDetailError] = useState<{ scope: string; chatId: string; notFound: boolean } | null>(null);
  const [activeChatId, setActiveChatId] = useCanonicalChatSelection({
    scope: composerIdentity, candidates: records, authoritativeItems: navigation.items,
    fresh: navigation.fresh, truncated: navigation.truncated,
    missingId: detailError?.scope === navigationIdentity && detailError.notFound ? detailError.chatId : undefined,
    initialExplicit: Boolean(initialDraft || initialCollaborationView),
  });
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
  const [botEventRevision, setBotEventRevision] = useState(0);
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
  const initialDraftConsumed = useRef(false);
  const previousNavigationIdentity = useRef(navigationIdentity);
  const previousComposerIdentity = useRef(composerIdentity);
  const sameAuthority = previousNavigationIdentity.current === navigationIdentity && isCurrent();
  detailRef.current = sameAuthority && detail?.record.chat.id === activeChatId ? detail : null;
  activeChatIdRef.current = activeChatId;

  useEffect(() => {
    if (previousNavigationIdentity.current === navigationIdentity) return;
    previousNavigationIdentity.current = navigationIdentity;
    detailRequestGeneration.current += 1;
    activeChatIdRef.current = activeChatId;
    detailRef.current = null;
    setDetail(null);
    setSelectedCollaborationView(null);
    setSafeError(null);
    inputAttempt.current = null;
    submittingRef.current = false;
    setSubmitting(false);
    if (previousComposerIdentity.current !== composerIdentity) {
      previousComposerIdentity.current = composerIdentity;
      setComposerDraftRequest(null);
    }
  }, [navigationIdentity, activeChatId, composerIdentity]);

  useEffect(() => {
    const synchronizeFromHistory = () => {
      if (!isCurrent()) return;
      const view = collaborationViewFromPathname(window.location.pathname);
      if (view) {
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
  }, [setActiveChatId, isCurrent]);

  useEffect(() => {
    if (!initialDraft || initialDraftConsumed.current) return;
    initialDraftConsumed.current = true;
    activeChatIdRef.current = undefined;
    detailRef.current = null;
    detailRequestGeneration.current += 1;
    setActiveChatId(undefined);
    setDetail(null);
    setComposerDraftRequest({ id: ++composerDraftSequence.current, text: initialDraft });
  }, [initialDraft, setActiveChatId]);

  const loadList=useCallback(async()=>{if (!isCurrent()) return; refreshUnread(); await navigation.store?.refresh();},[navigation.store, refreshUnread, isCurrent]);

  const loadDetail = useCallback(async (chatId: string) => {
    if (!isCurrent()) return null;
    const generation = ++detailRequestGeneration.current;
    try {
      let value = await client.detail(chatId);
      if (!isCurrent() || activeChatIdRef.current !== chatId || detailRequestGeneration.current !== generation) {
        return null;
      }
      const current = detailRef.current;
      if (current?.record.chat.id === chatId
        && current.record.chat.revision > value.record.chat.revision) {
        return current;
      }
      const known = recordsRef.current.find((item) => item.chat.id === chatId);
      const merged = known ? mergeChatNavigationRecord(value.record, known) : value.record;
      const titleRecord = current?.record.chat.id === chatId
        ? mergeCanonicalChatRecord(current.record, merged) : merged;
      value = { ...value, record: { ...value.record, chat: { ...value.record.chat,
        title: titleRecord.chat.title, titleVersion: titleRecord.chat.titleVersion,
      } } };
      if (current) value = { ...value, record: mergeChatReadState(value.record, current.record) };
      detailRef.current = value;
      setDetail(value);
      setDetailError(null);
      setSafeError(null);
      return value;
    } catch (error: unknown) {
      if (!isCurrent() || activeChatIdRef.current !== chatId || detailRequestGeneration.current !== generation) {
        return null;
      }
      console.warn("[canonical-chat] Shell detail unavailable:", error instanceof Error ? error.name : "UnknownError");
      setDetailError({ scope: navigationIdentity, chatId, notFound: error instanceof CanonicalShellChatRequestError && error.status === 404 });
      return null;
    }
  }, [client, navigationIdentity, isCurrent]);


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
    const subscription = eventSource.subscribe((event) => {
      if (!isCurrent()) return;
      if (event.type === "chat.changed" && event.chatId === activeChatId
        && /^(?:interaction\.|bot\.)/.test(event.eventType)) {
        setBotEventRevision((revision) => revision + 1);
      }
      if (event.type === "chat.changed" && event.content) {
        const record = event.content.content.record;
        if (event.eventType === "run.message") navigation.store?.patch(record);
        setRecords((current) => current.map((item) => item.chat.id === record.chat.id
          ? mergeChatNavigationRecord(item, record) : item), event.eventType !== "run.message");
        if (event.chatId === activeChatId) {
          const current = detailRef.current;
          const next = current ? applyCanonicalChatContent(current, event.content) : null;
          if (next && current) {
            const merged = { ...next, record: mergeCanonicalChatRecord(current.record, next.record) };
            detailRef.current = merged;
            setDetail(merged);
            setDetailError(null);
            setSafeError(null);
          } else selectedRefresh.schedule();
        }
        return;
      }
      if (event.type === "chat.full_refresh" || event.eventType !== "run.message") {
        refreshUnread();
      }
      if (event.type === "chat.full_refresh" || event.chatId === activeChatId) {
        selectedRefresh.schedule(EVENT_INVALIDATION_COALESCE_MS);
      }

    });
    return () => {
      subscription.dispose();
      selectedRefresh.dispose();
    };
  }, [activeChatId, eventSource, loadDetail, loadList, setRecords, refreshUnread, navigation.store, isCurrent]);

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
          navigation.store?.ensure(),
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
  }, [loadDetail, navigation.store]);

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
    if (!isCurrent()) return false;
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
          setActiveChatId(undefined);
          record = await client.create({
            clientRequestId: options.clientRequestId ? `${options.clientRequestId}_chat` : requestId(),
            title: generatedChatTitle(options.displayText?.trim() || text),
            currentSelection: selection,
          });
          if (!isCurrent()) return false;
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
        if (!isCurrent()) return false;
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
          const attempt = mentionRequests.resolve(authority.summaryClient ?? client, requestScope, semanticInput, operation, seed);
          input.clientRequestId = attempt.clientRequestId;
          operation = attempt.operation;
        }
        if (operation === "queue") {
          const queued = await client.queueTurn(record.chat.id, input);
          if (!isCurrent()) return false;
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
          return isCurrent();
        }
        const admitted = await client.admitTurn(record.chat.id, input);
        if (!isCurrent()) return false;
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
        return isCurrent();
      } catch (error: unknown) {
        if (!isCurrent()) return false;
        const definitelyUnadmitted = !admissionAttempted || isDefinitiveCanonicalChatRejection(error);
        if (!turnAdmitted && definitelyUnadmitted && uploadedReferences.length > 0) {
          await Promise.allSettled(uploadedReferences.map((reference) => client.deleteAttachment(reference)));
        }
        if (!isCurrent()) return false;
        console.warn("[canonical-chat] Shell Turn admission failed:", error instanceof Error ? error.name : "UnknownError");
        if (activeChatIdRef.current === sourceChatId) setSafeError(canonicalShellChatFailureMessage(error));
        return turnAdmitted;
      }
    };
    return send().finally(() => {
      if (!isCurrent()) return;
      submittingRef.current = false;
      setSubmitting(false);
    });
  }, [activeChatId, client, loadDetail, loadList, mentionRequests, setActiveChatId, isCurrent, authority.summaryClient]);

  const cancelQueuedTurn = useCallback(async (queuedTurnId: string) => {
    if (!isCurrent()) return false;
    const current = detailRef.current;
    if (!activeChatId || current?.record.chat.id !== activeChatId) return false;
    try {
      await client.cancelQueuedTurn(activeChatId, queuedTurnId, { clientRequestId: requestId(), baseRevision: current.record.chat.revision });
      if (!isCurrent()) return false;
      await loadDetail(activeChatId);
      return isCurrent();
    } catch (error: unknown) {
      if (!isCurrent()) return false;
      console.warn("[canonical-chat] Queue cancellation failed:", error instanceof Error ? error.name : "UnknownError");
      if (activeChatIdRef.current === activeChatId) setSafeError("Queued request could not be cancelled. Try again.");
      return false;
    }
  }, [activeChatId, client, loadDetail, isCurrent]);

  const newChat = useCallback(async () => {
    if (!isCurrent()) return;
    activeChatIdRef.current = undefined;
    detailRef.current = null;
    detailRequestGeneration.current += 1;
    setActiveChatId(undefined);
    setDetail(null);
    setSafeError(null);
    setSelectedCollaborationView(null);
    leaveSharedChatPath();
  }, [setActiveChatId, isCurrent]);

  const switchConversation = useCallback((chatId: string) => {
    if (!isCurrent()) return;
    activeChatIdRef.current = chatId;
    detailRef.current = null;
    detailRequestGeneration.current += 1;
    setActiveChatId(chatId);
    setDetail(null);
    setSafeError(null);
    setSelectedCollaborationView(null);
    leaveSharedChatPath();
  }, [setActiveChatId, isCurrent]);

  const openSharedChat = useCallback((scopeId: string) => {
    if (!isCurrent()) return;
    activeChatIdRef.current = undefined;
    detailRef.current = null;
    detailRequestGeneration.current += 1;
    setActiveChatId(undefined);
    setDetail(null);
    setSafeError(null);
    setSelectedCollaborationView({ kind: "chat", scopeId });
    pushShellChatPath(`/shared/chat/${encodeURIComponent(scopeId)}`);
  }, [setActiveChatId, isCurrent]);

  const openSharedProject = useCallback((scopeId: string) => {
    if (!isCurrent()) return;
    activeChatIdRef.current = undefined;
    detailRef.current = null;
    detailRequestGeneration.current += 1;
    setActiveChatId(undefined);
    setDetail(null);
    setSafeError(null);
    setSelectedCollaborationView({ kind: "project", scopeId });
    pushShellChatPath(`/shared/project/${encodeURIComponent(scopeId)}`);
  }, [setActiveChatId, isCurrent]);

  const openSharedHome = useCallback(() => {
    if (!isCurrent()) return;
    activeChatIdRef.current = undefined;
    detailRef.current = null;
    detailRequestGeneration.current += 1;
    setActiveChatId(undefined);
    setDetail(null);
    setSafeError(null);
    setSelectedCollaborationView({ kind: "home" });
    pushShellChatPath("/shared");
  }, [setActiveChatId, isCurrent]);

  const abortCurrent = useCallback(() => {
    if (!isCurrent()) return false;
    const current = detailRef.current;
    if (!current?.record.activeRun || current.record.chat.id !== activeChatIdRef.current) return;
    const chatId = current.record.chat.id;
    void client.cancelRun(chatId, current.record.activeRun.runId, requestId())
      .then(() => { if (isCurrent() && activeChatIdRef.current === chatId) return loadDetail(chatId); })
      .catch((error: unknown) => {
        if (!isCurrent()) return;
        console.warn("[canonical-chat] Shell cancellation failed:", error instanceof Error ? error.name : "UnknownError");
        if (activeChatIdRef.current === chatId) setSafeError("The run could not be stopped. Try again.");
      });
  }, [client, loadDetail, isCurrent]);

  const submitInput = useCallback(async (
    runId: string,
    inputRequestId: string,
    input: Omit<CanonicalSubmitChatInputRequest, "clientRequestId">,
  ) => {
    if (!isCurrent()) return false;
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
      if (!isCurrent()) return false;
      if (activeChatIdRef.current === chatId) await loadDetail(chatId);
      return isCurrent();
    } catch (error: unknown) {
      if (!isCurrent()) return false;
      console.warn("[canonical-chat] Shell input submission failed:", error instanceof Error ? error.name : "UnknownError");
      if (activeChatIdRef.current === chatId) await loadDetail(chatId);
      if (isCurrent() && activeChatIdRef.current === chatId) setSafeError("Your answer could not be submitted. Try again.");
      return false;
    } finally {
      attempt.inFlight = false;
    }
  }, [client, loadDetail, isCurrent]);

  const submitApproval = useCallback(async (
    runId: string,
    approvalId: string,
    decision: CanonicalChatApprovalDecision,
  ) => {
    if (!isCurrent()) return false;
    const current = detailRef.current;
    if (!current?.record.activeRun || current.record.chat.id !== activeChatIdRef.current
      || current.record.activeRun.runId !== runId) {
      setSafeError("The approval could not be submitted. Refresh and try again.");
      return false;
    }
    try {
      const approval = canonicalChatApprovals(current).find(item =>
        item.pending && item.runId === runId && item.approvalId === approvalId);
      await client.submitApproval(
        current.record.chat.id,
        runId,
        approvalId,
        decision,
        requestId(),
        approval?.actionDigest,
      );
      if (!isCurrent()) return false;
      await loadDetail(current.record.chat.id);
      return isCurrent();
    } catch (error: unknown) {
      if (!isCurrent()) return false;
      console.warn("[canonical-chat] Shell approval failed:", error instanceof Error ? error.name : "UnknownError");
      setSafeError("The approval could not be submitted. Refresh and try again.");
      await loadDetail(current.record.chat.id);
      return false;
    }
  }, [client, loadDetail, isCurrent]);

  const renameConversation = useCallback(async (chatId: string, title: string) => {
    if (!isCurrent()) return false;
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
      if (!isCurrent()) return false;
      setRecords((existing) => existing.map((record) => record.chat.id === chatId
        ? mergeChatNavigationRecord(record, updated) : record));
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
      if (!isCurrent()) return false;
      console.warn("[canonical-chat] Shell rename failed:", error instanceof Error ? error.name : "UnknownError");
      await loadList();
      await loadDetail(chatId);
      if (isCurrent()) setSafeError("The Chat could not be renamed. Try again.");
      return false;
    }
  }, [client, records, loadList, loadDetail, setRecords, isCurrent]);

  const updateReadState = useCallback(async (chatId: string, input: import("@matrix-os/contracts").CanonicalUpdateChatReadStateRequest) => {
    if (!isCurrent()) return false;
    try {
      const response = await client.updateReadState(chatId, input);
      if (!isCurrent()) return false;
      setRecords((current) => current.map((record) => mergeChatReadState(record, response)));
      const current = detailRef.current;
      if (current?.record.chat.id === chatId) {
        const next = { ...current, record: mergeChatReadState(current.record, response) };
        detailRef.current = next;
        setDetail(next);
      }
      return true;
    } catch (error: unknown) {
      if (!isCurrent()) return false;
      console.warn("[chat] Read state update failed:", error instanceof Error ? error.name : "UnknownError");
      setSafeError("The Chat could not be updated. Try again.");
      return false;
    }
  }, [client, setRecords, isCurrent]);

  const selectedDetail = sameAuthority && detail?.record.chat.id === activeChatId ? detail : null;
  const messages = selectedDetail ? projectCanonicalTranscript(selectedDetail) : [];
  const selectedDetailError = detailError?.scope === navigationIdentity && detailError.chatId === activeChatId
    ? "Chat could not be loaded. Try again." : null;
  const visibleError = (sameAuthority ? safeError : null) ?? selectedDetailError ?? unreadNavigation.error ?? navigation.error;
  if (visibleError) {
    messages.push({ id: "canonical-safe-error", role: "system", content: visibleError, timestamp: Date.now() });
  }
  const activeRecord = selectedDetail
    ? selectedDetail.record
    : records.find((record) => record.chat.id === activeChatId);
  const detailLoading = activeChatId !== undefined && detail?.record.chat.id !== activeChatId;
  const projectedSharedChat = sharedChatMembershipFromProjection(selectedDetail?.record.chat.collaboration);
  const collaborationView = (sameAuthority ? selectedCollaborationView : null)
    ?? (projectedSharedChat && activeRecord
      ? { kind: "canonical-chat" as const, chatId: activeRecord.chat.id }
      : undefined);
  return {
    collaborationView,
    openSharedChat,
    openSharedProject,
    openSharedHome,
    unreadOnly, setUnreadOnly,
    readState: selectedDetail?.record.readState,
    displayedThroughSeq: Math.max(0, ...(selectedDetail?.messages ?? []).filter((message) => message.role === "assistant" && message.state === "committed").map((message) => message.seq)),
    updateReadState,
    messages,
    sessionId: activeChatId,
    busy: (sameAuthority && submitting) || detailLoading || Boolean(selectedDetail?.record.activeRun),
    activeRunId: selectedDetail?.record.activeRun?.runId,
    currentTool: null,
    connected,
    queue: [],
    agentClient: authority.agentClient,
    agentSummaryClient: authority.summaryClient,
    authorityKey: navigationIdentity,
    composerIdentity,
    isCurrentAuthority: isCurrent,
    botEventRevision,
    queuedTurns: selectedDetail?.queuedTurns ?? [],
    cancelQueuedTurn,
    providerSelection: selectedDetail?.record.chat.currentSelection,
    boundProviderInstanceId: selectedDetail?.record.providerBinding?.instanceId,
    conversations: records.map(conversationMeta),
    navigationFresh:navigation.fresh,
    navigationClassifications: unreadNavigation.items.map(item=>({chatId:item.chat.id,classification:item.classification})),
    activeConversationTitle: activeRecord?.chat.title,
    renameConversation,
    composerDraftRequest: sameAuthority && previousComposerIdentity.current === composerIdentity ? composerDraftRequest : null,
    requestComposerDraft: (text) => { if (isCurrent()) setComposerDraftRequest({ id: ++composerDraftSequence.current, text }); },
    consumeComposerDraft: (id) => { if (isCurrent()) setComposerDraftRequest((current) => current?.id === id ? null : current); },
    submitMessage,
    newChat,
    switchConversation,
    abortCurrent,
    submitApproval,
    submitInput,
  };
}
