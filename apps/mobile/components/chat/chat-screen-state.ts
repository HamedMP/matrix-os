import type { CanonicalChatDetailResponse, CanonicalChatRecord, CanonicalChatRun } from "@matrix-os/contracts";

const FINISHED_RUN_STATUSES: readonly string[] = ["completed", "failed", "aborted"];

/** The top bar's title: "New chat", or what the side panel calls the open chat. */
export function chatScreenTitle(
  chatId: string | null,
  detail: CanonicalChatDetailResponse | null,
  chats: readonly CanonicalChatRecord[],
): string {
  if (!chatId) return "New chat";
  // The list knows a chat's title before its detail has loaded.
  const chat = detail?.record.chat.id === chatId
    ? detail.record.chat
    : chats.find((record) => record.chat.id === chatId)?.chat;
  return chat?.title.trim() || chat?.lastMessagePreview?.trim() || "New chat";
}

export function composerPlaceholder({ connected, chatOpen }: { connected: boolean; chatOpen: boolean }): string {
  if (!connected) return "Signing in…";
  return chatOpen ? "Reply…" : "Ask anything";
}

/** The run a stop button would stop: the latest one that has not finished. */
export function activeChatRun(detail: CanonicalChatDetailResponse | null): CanonicalChatRun | undefined {
  return detail?.runs.filter((run) => !FINISHED_RUN_STATUSES.includes(run.status)).at(-1);
}

/**
 * Whether a path with no root in a reply (`apps/notes`) is relative to the
 * home folder, where apps live. As on desktop, that holds only for a chat
 * outside any project whose run had no workspace of its own.
 */
export function allowsHomeRelativeAppPaths(detail: CanonicalChatDetailResponse | null, messageId: string): boolean {
  if (!detail || detail.record.projectId) return false;
  const runId = detail.messages.find((message) => message.id === messageId)?.runId;
  const run = runId ? detail.runs.find((candidate) => candidate.id === runId) : undefined;
  return !run?.executionRoot;
}
