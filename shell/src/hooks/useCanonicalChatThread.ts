"use client";

import {
  applyCanonicalChatContent,
  createCanonicalChatRefresh,
  generatedChatTitle,
  mergeCanonicalChatRecord,
  mergeChatReadState,
  type CanonicalChatEventSource,
  type ChatAgentDraftRequest,
} from "@matrix-os/ui";
import type {
  CanonicalChatDetailResponse,
  CanonicalChatMessagePart,
  CanonicalChatRecord,
  CanonicalUpdateChatReadStateRequest,
} from "@matrix-os/contracts";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ChatSubmitOptions } from "@/hooks/useChatState";
import { canonicalShellChatFailureMessage, type CanonicalShellChatClient } from "@/lib/canonical-chat-client";
import { projectCanonicalTranscript } from "@/lib/canonical-chat-terminal-notices";

const ACTIVE_RUN_FALLBACK_POLL_MS = 2_000;
const EVENT_INVALIDATION_COALESCE_MS = 200;

function requestId(): string {
  return `req_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

type SendOptions = ChatSubmitOptions & Required<Pick<ChatSubmitOptions, "instanceId" | "model" | "interactionMode" | "permissionMode">>;

/** Makes the Chat for a draft (shown through `onCreated`), then admits the turn. */
async function admitThreadTurn({ client, createChat, record: known, text, options, onCreated }: {
  client: CanonicalShellChatClient; createChat: CanonicalChatThreadOptions["createChat"];
  record: CanonicalChatRecord | null; text: string; options: SendOptions; onCreated: (record: CanonicalChatRecord) => void;
}) {
  let record = known;
  if (!record) {
    record = await createChat({
      clientRequestId: options.clientRequestId ? `${options.clientRequestId}_chat` : requestId(),
      title: generatedChatTitle(options.displayText?.trim() || text),
    });
    onCreated(record);
  }
  const parts: CanonicalChatMessagePart[] = [
    { type: "text", text: options.promptText?.trim() || text.trim() },
    ...(options.resources ?? []).map((resource) => ({ type: "resource_reference" as const, resource })),
  ];
  const admitted = await client.admitTurn(record.chat.id, {
    clientRequestId: options.clientRequestId ?? requestId(), baseRevision: record.chat.revision, parts,
    selection: { instanceId: options.instanceId, model: options.model, ...(options.modelOptions?.length ? { options: options.modelOptions } : {}) },
    interactionMode: options.interactionMode, permissionMode: options.permissionMode,
  });
  return { record, admitted };
}

export interface CanonicalChatThreadOptions {
  client: CanonicalShellChatClient;
  /** The shell's one shared event stream (useCanonicalChatState owns it). */
  eventSource: Pick<CanonicalChatEventSource, "subscribe" | "subscribeConnectionState" | "connectionState">;
  /** The Chat to show, or null for a draft. Read once: a host shows another Chat by remounting the view. */
  chatId: string | null;
  /** Makes the Chat on a draft's first send, in place of POST /api/chats. */
  createChat: (input: { clientRequestId: string; title: string }) => Promise<CanonicalChatRecord>;
  /** Reports the Chat after every admitted turn, so a host list can sort and date it (a new Chat comes from createChat). */
  onChatChanged?: (chatId: string, title: string) => void;
}

/**
 * One Chat for a host that is not the Chat app (the Company Brain): the same transcript, content deltas, snapshot
 * refresh and turn admission as the Chat app, without its list, URL paths or global selection. Returns ChatApp props.
 */
export function useCanonicalChatThread({
  client, eventSource, chatId: openedChatId, createChat, onChatChanged,
}: CanonicalChatThreadOptions) {
  const [chatId, setChatId] = useState(openedChatId);
  const [detail, setDetail] = useState<CanonicalChatDetailResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [safeError, setError] = useState<{ text: string; at: number } | null>(null);
  const setSafeError = useCallback((text: string | null) => setError(text === null ? null : { text, at: Date.now() }), []);
  const [botEventRevision, setBotEventRevision] = useState(0);
  // The question of a first send whose new Chat refused the turn: the view's composer for that Chat gets it back.
  const [returnedDraft, setReturnedDraft] = useState<ChatAgentDraftRequest | null>(null);
  const returnedDrafts = useRef(0);
  const detailRef = useRef(detail);
  const chatIdRef = useRef(chatId);
  const submittingRef = useRef(false);
  const generation = useRef(0);
  const subscribeStream = useCallback((notify: () => void) => {
    const subscription = eventSource.subscribeConnectionState(notify);
    return () => subscription.dispose();
  }, [eventSource]);
  const readStream = useCallback(() => eventSource.connectionState(), [eventSource]);
  const streamState = useSyncExternalStore(subscribeStream, readStream, readStream);

  const show = useCallback((next: CanonicalChatDetailResponse) => {
    detailRef.current = next;
    setDetail(next);
  }, []);

  /** True when the snapshot is current (or a newer request owns it), so the shared refresh stops retrying. */
  const loadDetail = useCallback(async (id: string) => {
    const sequence = ++generation.current;
    try {
      const loaded = await client.detail(id);
      if (sequence !== generation.current || chatIdRef.current !== id) return true;
      const current = detailRef.current;
      if (current?.record.chat.id === id && current.record.chat.revision > loaded.record.chat.revision) return true;
      show(current?.record.chat.id === id ? { ...loaded, record: mergeChatReadState(loaded.record, current.record) } : loaded);
      setSafeError(null);
      return true;
    } catch (error: unknown) {
      if (sequence !== generation.current || chatIdRef.current !== id) return true;
      console.warn("[canonical-chat] Thread detail unavailable:", error instanceof Error ? error.name : "UnknownError");
      setSafeError("Chat could not be loaded. Try again.");
      return false;
    }
  }, [client, setSafeError, show]);

  useEffect(() => {
    if (chatId === null) return;
    const refresh = createCanonicalChatRefresh(() => loadDetail(chatId));
    refresh.schedule();
    const subscription = eventSource.subscribe((event) => {
      if (event.type === "chat.full_refresh") {
        refresh.schedule(EVENT_INVALIDATION_COALESCE_MS);
        return;
      }
      if (event.chatId !== chatId) return;
      if (/^(?:interaction\.|bot\.)/.test(event.eventType)) setBotEventRevision((revision) => revision + 1);
      const current = detailRef.current;
      const next = current && event.content ? applyCanonicalChatContent(current, event.content) : null;
      if (current && next) {
        show({ ...next, record: mergeCanonicalChatRecord(current.record, next.record) });
        setSafeError(null);
      } else refresh.schedule(event.content ? 0 : EVENT_INVALIDATION_COALESCE_MS);
    });
    const onVisible = () => { if (document.visibilityState === "visible") refresh.schedule(); };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      subscription.dispose();
      refresh.dispose();
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [chatId, eventSource, loadDetail, setSafeError, show]);

  // Without an open stream, a running answer is followed by polling the snapshot.
  const running = Boolean(detail?.record.activeRun);
  useEffect(() => {
    if (chatId === null || !running || streamState === "open") return;
    const timer = window.setInterval(() => { void loadDetail(chatId); }, ACTIVE_RUN_FALLBACK_POLL_MS);
    return () => window.clearInterval(timer);
  }, [chatId, running, streamState, loadDetail]);

  const onSubmit = useCallback((
    text: string, _files?: Array<{ name: string; type: string; data: string }>, options?: ChatSubmitOptions,
  ) => {
    if (!text.trim() || submittingRef.current) return Promise.resolve(false);
    if (!options?.instanceId || !options.model || !options.interactionMode || !options.permissionMode) {
      setSafeError("Choose an available harness and model.");
      return Promise.resolve(false);
    }
    const record = detailRef.current?.record ?? null;
    if (!record && chatIdRef.current !== null) {
      setSafeError("Wait for this chat to finish loading.");
      return Promise.resolve(false);
    }
    submittingRef.current = true;
    setSubmitting(true);
    setSafeError(null);
    const onCreated = (created: CanonicalChatRecord) => {
      chatIdRef.current = created.chat.id;
      setChatId(created.chat.id);
      show({ record: created, messages: [], turns: [], runs: [], activities: [] });
    };
    return admitThreadTurn({ client, createChat, record, text, options: options as SendOptions, onCreated }).then(
      async ({ record: sent, admitted }) => {
        const current = detailRef.current;
        if (current?.record.chat.id === sent.chat.id && current.record.chat.revision < admitted.record.chat.revision) {
          show({
            ...current, record: admitted.record, messages: [...current.messages, admitted.message],
            turns: [...current.turns, admitted.turn], runs: [...current.runs, admitted.run],
          });
        }
        onChatChanged?.(sent.chat.id, admitted.record.chat.title);
        await loadDetail(sent.chat.id);
        return true;
      },
      (error: unknown) => {
        console.warn("[canonical-chat] Thread turn failed:", error instanceof Error ? error.name : "UnknownError");
        setSafeError(canonicalShellChatFailureMessage(error));
        if (!record && chatIdRef.current !== null) {
          returnedDrafts.current += 1;
          setReturnedDraft({ id: returnedDrafts.current, text, ...(options.resources?.length ? { resources: options.resources } : {}) });
        }
        return false;
      },
    ).finally(() => {
      submittingRef.current = false;
      setSubmitting(false);
    });
  }, [client, createChat, loadDetail, onChatChanged, setSafeError, show]);

  const onAbortCurrent = useCallback(() => {
    const current = detailRef.current;
    const run = current?.record.activeRun;
    if (!current || !run) return;
    const id = current.record.chat.id;
    client.cancelRun(id, run.runId, requestId()).then(() => loadDetail(id)).catch((error: unknown) => {
      console.warn("[canonical-chat] Thread cancellation failed:", error instanceof Error ? error.name : "UnknownError");
      setSafeError("The run could not be stopped. Try again.");
    });
  }, [client, loadDetail, setSafeError]);

  const onComposerDraftConsumed = useCallback((id: number) => {
    setReturnedDraft((current) => (current?.id === id ? null : current));
  }, []);

  const onUpdateReadState = useCallback(async (id: string, input: CanonicalUpdateChatReadStateRequest) => {
    try {
      const response = await client.updateReadState(id, input);
      const current = detailRef.current;
      if (current?.record.chat.id === id) show({ ...current, record: mergeChatReadState(current.record, response) });
      return true;
    } catch (error: unknown) {
      console.warn("[canonical-chat] Thread read state failed:", error instanceof Error ? error.name : "UnknownError");
      return false;
    }
  }, [client, show]);

  const shown = detail?.record.chat.id === chatId ? detail : null;
  const messages = shown ? projectCanonicalTranscript(shown) : [];
  if (safeError) messages.push({ id: "canonical-safe-error", role: "system", content: safeError.text, timestamp: safeError.at });
  return {
    messages,
    sessionId: chatId ?? undefined,
    busy: submitting || (chatId !== null && shown === null) || Boolean(shown?.record.activeRun),
    activeRunId: shown?.record.activeRun?.runId,
    onAbortCurrent,
    onSubmit,
    readState: shown?.record.readState,
    displayedThroughSeq: Math.max(0, ...(shown?.messages ?? [])
      .filter((message) => message.role === "assistant" && message.state === "committed").map((message) => message.seq)),
    onUpdateReadState,
    activeConversationTitle: shown?.record.chat.title,
    botEventRevision,
    queuedTurns: shown?.queuedTurns ?? [],
    providerSelection: shown?.record.chat.currentSelection,
    boundProviderInstanceId: shown?.record.providerBinding?.instanceId,
    composerDraftRequest: returnedDraft,
    onComposerDraftConsumed,
  };
}
