"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CanonicalChatApprovalDecision,
  CanonicalChatDetailResponse,
  CanonicalChatRecord,
} from "@matrix-os/contracts";
import { useSocket } from "@/hooks/useSocket";
import type { ChatState, ChatSubmitOptions } from "@/hooks/useChatState";
import { getGatewayUrl } from "@/lib/gateway";
import {
  createCanonicalShellChatClient,
  isDefinitiveCanonicalChatRejection,
  projectCanonicalMessages,
} from "@/lib/canonical-chat-client";

const ACTIVE_RUN_POLL_MS = 500;

function requestId(): string {
  return `req_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

function conversationMeta(record: CanonicalChatRecord) {
  return {
    id: record.chat.id,
    preview: record.chat.lastMessagePreview ?? record.chat.title,
    messageCount: record.chat.messageCount,
    createdAt: Date.parse(record.chat.createdAt),
    updatedAt: Date.parse(record.chat.updatedAt),
  };
}

export function useCanonicalChatState(): ChatState {
  const client = useMemo(() => createCanonicalShellChatClient({ gatewayUrl: getGatewayUrl() }), []);
  const { connected } = useSocket();
  const [records, setRecords] = useState<CanonicalChatRecord[]>([]);
  const [activeChatId, setActiveChatId] = useState<string>();
  const [detail, setDetail] = useState<CanonicalChatDetailResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [safeError, setSafeError] = useState<string | null>(null);
  const [composerDraftRequest, setComposerDraftRequest] = useState<{ id: number; text: string } | null>(null);
  const composerDraftSequence = useRef(0);
  const detailRequestGeneration = useRef(0);
  const detailRef = useRef(detail);
  const activeChatIdRef = useRef(activeChatId);
  detailRef.current = detail;
  activeChatIdRef.current = activeChatId;

  const loadList = useCallback(async () => {
    try {
      const page = await client.list();
      setRecords(page.items);
      setActiveChatId((current) => current ?? page.items[0]?.chat.id);
    } catch (error: unknown) {
      console.warn("[canonical-chat] Shell list unavailable:", error instanceof Error ? error.name : "UnknownError");
      setSafeError("Chats could not be loaded. Try again.");
    }
  }, [client]);

  const loadDetail = useCallback(async (chatId: string) => {
    const generation = ++detailRequestGeneration.current;
    try {
      const value = await client.detail(chatId);
      if (activeChatIdRef.current !== chatId || detailRequestGeneration.current !== generation) {
        return null;
      }
      const current = detailRef.current;
      if (current?.record.chat.id === chatId
        && current.record.chat.revision > value.record.chat.revision) {
        return null;
      }
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
    if (!activeChatId || !detail?.record.activeRun) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = () => {
      timer = window.setTimeout(async () => {
        await loadDetail(activeChatId);
        if (!cancelled) poll();
      }, ACTIVE_RUN_POLL_MS);
    };
    poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeChatId, Boolean(detail?.record.activeRun), loadDetail]);

  const submitMessage = useCallback((
    text: string,
    files?: Array<{ name: string; type: string; data: string }>,
    options?: ChatSubmitOptions,
  ) => {
    if (!text.trim() || submitting) return;
    if (activeChatId && detailRef.current?.record.chat.id !== activeChatId) {
      setSafeError("Wait for this chat to finish loading.");
      return;
    }
    if (!options?.instanceId || !options.model || !options.interactionMode || !options.permissionMode) {
      setSafeError("Choose an available harness and model.");
      return;
    }
    setSubmitting(true);
    setSafeError(null);
    void (async () => {
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
          record = await client.create({
            clientRequestId: requestId(),
            title: (options.displayText?.trim() || text.trim()).slice(0, 200),
            currentSelection: selection,
          });
          setActiveChatId(record.chat.id);
        }
        if ((files?.length ?? 0) > 8) throw new Error("TooManyAttachments");
        const uploadResults = await Promise.allSettled((files ?? []).map(async (file) => {
          const reference = await client.uploadAttachment(file);
          if (!reference.ownerReference) throw new Error("InvalidAttachmentReference");
          uploadedReferences.push(reference.ownerReference);
          return reference;
        }));
        const failedUpload = uploadResults.find((result) => result.status === "rejected");
        if (failedUpload?.status === "rejected") throw failedUpload.reason;
        const attachmentParts = uploadResults.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : []);
        admissionAttempted = true;
        const admitted = await client.admitTurn(record.chat.id, {
          clientRequestId: requestId(),
          baseRevision: record.chat.revision,
          parts: [{ type: "text", text: options.promptText?.trim() || text.trim() }, ...attachmentParts],
          selection,
          interactionMode: options.interactionMode!,
          permissionMode: options.permissionMode!,
        });
        turnAdmitted = true;
        setDetail((current) => ({
          record: admitted.record,
          messages: [...(current?.record.chat.id === record.chat.id ? current.messages : []), admitted.message],
          turns: [...(current?.record.chat.id === record.chat.id ? current.turns : []), admitted.turn],
          runs: [...(current?.record.chat.id === record.chat.id ? current.runs : []), admitted.run],
          activities: current?.record.chat.id === record.chat.id ? current.activities : [],
        }));
        await loadList();
        await loadDetail(record.chat.id);
      } catch (error: unknown) {
        const definitelyUnadmitted = !admissionAttempted || isDefinitiveCanonicalChatRejection(error);
        if (!turnAdmitted && definitelyUnadmitted && uploadedReferences.length > 0) {
          await Promise.allSettled(uploadedReferences.map((reference) => client.deleteAttachment(reference)));
        }
        console.warn("[canonical-chat] Shell Turn admission failed:", error instanceof Error ? error.name : "UnknownError");
        setSafeError("Message could not be sent. Try again.");
      } finally {
        setSubmitting(false);
      }
    })();
  }, [activeChatId, client, loadDetail, loadList, submitting]);

  const newChat = useCallback(async () => {
    detailRequestGeneration.current += 1;
    setActiveChatId(undefined);
    setDetail(null);
    setSafeError(null);
  }, []);

  const switchConversation = useCallback((chatId: string) => {
    detailRequestGeneration.current += 1;
    setActiveChatId(chatId);
    setDetail(null);
    setSafeError(null);
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

  const messages = detail ? projectCanonicalMessages(detail.messages) : [];
  if (safeError) {
    messages.push({ id: "canonical-safe-error", role: "system", content: safeError, timestamp: Date.now() });
  }
  const activeRecord = detail && detail.record.chat.id === activeChatId
    ? detail.record
    : records.find((record) => record.chat.id === activeChatId);
  const detailLoading = activeChatId !== undefined && detail?.record.chat.id !== activeChatId;
  return {
    messages,
    sessionId: activeChatId,
    busy: submitting || detailLoading || Boolean(detail?.record.activeRun),
    currentTool: null,
    connected,
    queue: [],
    providerSelection: activeRecord?.chat.currentSelection,
    conversations: records.map(conversationMeta),
    composerDraftRequest,
    requestComposerDraft: (text) => setComposerDraftRequest({ id: ++composerDraftSequence.current, text }),
    consumeComposerDraft: (id) => setComposerDraftRequest((current) => current?.id === id ? null : current),
    submitMessage,
    newChat,
    switchConversation,
    abortCurrent,
    submitApproval,
  };
}
