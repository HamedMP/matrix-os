import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { useCallback, useMemo } from "react";
import { useRouter } from "expo-router";

import { CanonicalApprovalMessage } from "@/components/CanonicalApprovalMessage";
import { CanonicalInputMessage } from "@/components/CanonicalInputMessage";
import {
  buildTranscript,
  optimisticTranscriptMessage,
  type TranscriptMessage,
} from "@/lib/canonical-chat-transcript";
import { useCancelRun } from "@/lib/queries/use-cancel-run";

import { activeChatRun, allowsHomeRelativeAppPaths } from "./chat-screen-state";
import { ReplyResultApps } from "./ReplyResultApps";
import type { ChatResultApp } from "./types";

type OptimisticMessage = Parameters<typeof optimisticTranscriptMessage>[0];

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
}

/**
 * What a screen draws for one chat and offers on it: the messages, the
 * requests and result cards inside them, and stopping the run. The Chats tab
 * and an agent's chat both read their chat through this.
 */
export function useChatThread({ chatId, detail, gatewayUrl, refresh, optimisticMessages }: ChatThreadInput) {
  const router = useRouter();
  const { mutate: requestCancel, isPending: cancelPending } = useCancelRun();

  const messages = useMemo(() => {
    const transcript = buildTranscript(detail);
    if (optimisticMessages.length === 0) return transcript;
    // Newest first, as the message list takes them.
    return [...optimisticMessages.map(optimisticTranscriptMessage).reverse(), ...transcript];
  }, [detail, optimisticMessages]);

  const activeRunId = activeChatRun(detail)?.id;

  // A failed request changes nothing here: the run is still listed as active,
  // so the button is simply there to be pressed again.
  const onStop = useMemo(() => (
    chatId && activeRunId && !cancelPending
      ? () => requestCancel({ chatId, runId: activeRunId })
      : undefined
  ), [chatId, activeRunId, cancelPending, requestCancel]);

  const renderRequest = useCallback((item: TranscriptMessage) => {
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
          onSettled={refresh}
        />
      );
    }
    return null;
  }, [chatId, gatewayUrl, refresh]);

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
  };
}
