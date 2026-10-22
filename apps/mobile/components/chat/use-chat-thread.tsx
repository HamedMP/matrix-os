import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "expo-router";

import { CanonicalApprovalMessage } from "@/components/CanonicalApprovalMessage";
import { CanonicalInputMessage } from "@/components/CanonicalInputMessage";
import {
  buildTranscript,
  optimisticTranscriptMessage,
  withLocalAttachments,
  type TranscriptMessage,
} from "@/lib/canonical-chat-transcript";
import type { SentAttachmentUris } from "@/lib/chat-attachments";
import { useCancelRun } from "@/lib/queries/use-cancel-run";
import { useRetryChatTurn } from "@/lib/queries/use-retry-chat-turn";
import { canonicalChatRequestId } from "@/lib/requests";

import { activeChatRun, allowsHomeRelativeAppPaths } from "./chat-screen-state";
import { ComputerPhoto } from "./ComputerPhoto";
import type { ComputerPhotoRequest } from "./MessageAttachments";
import { ReplyResultApps } from "./ReplyResultApps";
import { RunNotice } from "./RunNotice";
import type { ChatResultApp } from "./types";

type OptimisticMessage = Parameters<typeof optimisticTranscriptMessage>[0];

// The message list reads nothing itself; this is how it draws a photo that is
// on the computer and not on the phone.
const renderComputerPhoto = (photo: ComputerPhotoRequest) => <ComputerPhoto {...photo} />;

const NOTHING_SENT: SentAttachmentUris = {};

interface ChatThreadInput {
  /** Null while there is no chat yet. */
  chatId: string | null;
  detail: CanonicalChatDetailResponse | null;
  /** Null until the computer is known. */
  gatewayUrl: string | null;
  /** Reads the chat again once a request in it has been answered. */
  refresh: () => Promise<unknown> | void;
  /** Messages sent from this screen that the server has not listed yet. */
  optimisticMessages: readonly OptimisticMessage[];
  /** Where attachments sent from this screen still are on the phone. */
  sentAttachments?: SentAttachmentUris;
}

/**
 * What a screen draws for one chat and offers on it: the messages, the
 * requests, failures and result cards inside them, stopping the run, and
 * running a failed turn again. The Chats tab and an agent's chat both read
 * their chat through this.
 */
export function useChatThread({
  chatId,
  detail,
  gatewayUrl,
  refresh,
  optimisticMessages,
  sentAttachments = NOTHING_SENT,
}: ChatThreadInput) {
  const router = useRouter();
  const { mutate: requestCancel, isPending: cancelPending } = useCancelRun();
  const {
    mutate: requestRetry,
    isPending: retryPending,
    isError: retryFailed,
    variables: retried,
  } = useRetryChatTurn();
  // One request id per failed run, so a retry whose answer was lost is taken
  // as the same retry when it is pressed again. A later failure is a new run
  // with a notice of its own, and gets a new id.
  const retryRequest = useRef<{ noticeId: string; clientRequestId: string } | null>(null);
  const [grantRefreshKey, setGrantRefreshKey] = useState<object>({});
  const refreshApprovals = useCallback(() => {
    // Grant mutations need not change any recorded Chat activity. Do not rely
    // on refetch returning new approval objects to invalidate sibling reads.
    setGrantRefreshKey({});
    return refresh();
  }, [refresh]);

  const messages = useMemo(() => {
    const transcript = withLocalAttachments(buildTranscript(detail), sentAttachments);
    if (optimisticMessages.length === 0) return transcript;
    // Newest first, as the message list takes them.
    return [...optimisticMessages.map(optimisticTranscriptMessage).reverse(), ...transcript];
  }, [detail, optimisticMessages, sentAttachments]);

  const activeRunId = activeChatRun(detail)?.id;
  // A message on its way starts a turn after the failed one, which is then no
  // longer the turn the computer would run again.
  const sendOnItsWay = optimisticMessages.some((message) => !message.failed);

  const retryTurn = useCallback((notice: TranscriptMessage) => {
    const turnId = notice.notice?.retryTurnId;
    if (!chatId || !detail || !turnId || activeRunId || retryPending) return;
    if (retryRequest.current?.noticeId !== notice.id) {
      retryRequest.current = { noticeId: notice.id, clientRequestId: canonicalChatRequestId() };
    }
    requestRetry({
      chatId,
      turnId,
      baseRevision: detail.record.chat.revision,
      clientRequestId: retryRequest.current.clientRequestId,
    });
  }, [chatId, detail, activeRunId, retryPending, requestRetry]);

  // A failed request changes nothing here: the run is still listed as active,
  // so the button is simply there to be pressed again.
  const onStop = useMemo(() => (
    chatId && activeRunId && !cancelPending
      ? () => requestCancel({ chatId, runId: activeRunId })
      : undefined
  ), [chatId, activeRunId, cancelPending, requestCancel]);

  const renderRequest = useCallback((item: TranscriptMessage) => {
    if (item.notice?.tone === "failed") {
      const turnId = item.notice.retryTurnId;
      const thisTurn = turnId !== undefined && retried?.chatId === chatId && retried?.turnId === turnId;
      return (
        <RunNotice
          text={item.text}
          onRetry={turnId && chatId ? () => retryTurn(item) : undefined}
          retrying={retryPending && thisTurn}
          retryDisabled={!gatewayUrl || activeRunId !== undefined || sendOnItsWay}
          retryFailed={retryFailed && thisTurn}
        />
      );
    }
    if (!chatId || !gatewayUrl) return null;
    if (item.input) {
      return (
        <CanonicalInputMessage
          key={`${chatId}:${item.input.runId}:${item.input.requestId}`}
          request={item.input}
          chatId={chatId}
          gatewayUrl={gatewayUrl}
          onSettled={refresh}
        />
      );
    }
    if (item.approval) {
      return (
        <CanonicalApprovalMessage
          key={`${chatId}:${item.approval.runId}:${item.approval.approvalId}`}
          approval={item.approval}
          chatId={chatId}
          gatewayUrl={gatewayUrl}
          grantRefreshKey={grantRefreshKey}
          onSettled={refreshApprovals}
        />
      );
    }
    return null;
  }, [chatId, gatewayUrl, refresh, grantRefreshKey, refreshApprovals, retryTurn, retryPending, retryFailed, retried, activeRunId, sendOnItsWay]);

  const openApp = useCallback((app: ChatResultApp) => {
    router.push({
      pathname: "/app-preview/[app]",
      params: { app: app.slug, runtimeSlug: app.runtimeSlug, name: app.name },
    } as never);
  }, [router]);

  const renderResults = useCallback((item: TranscriptMessage) => (
    <ReplyResultApps
      text={item.text}
      allowRelative={allowsHomeRelativeAppPaths(detail, item.id)}
      onOpen={openApp}
    />
  ), [detail, openApp]);

  return {
    /** Newest first. */
    messages,
    /** A turn is being worked on. */
    running: activeRunId !== undefined,
    /** Stops the run. Absent when there is none, or while a stop is already on its way. */
    onStop,
    renderRequest,
    renderResults,
    renderComputerPhoto,
  };
}
