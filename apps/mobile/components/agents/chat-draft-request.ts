import { useSyncExternalStore } from "react";

/** Text another screen wants in the new chat's composer. */
export interface ChatDraftRequest {
  /** Names this request, so taking it cannot drop a later one. */
  id: number;
  text: string;
}

// One request at a time: a later one replaces an earlier one nobody took.
let pending: ChatDraftRequest | null = null;
let lastId = 0;
// One entry per mounted `useChatDraftRequest`, removed when it unmounts.
let listeners: readonly (() => void)[] = [];

function publish(next: ChatDraftRequest | null) {
  pending = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners = [...listeners, listener];
  return () => {
    listeners = listeners.filter((existing) => existing !== listener);
  };
}

const currentRequest = () => pending;

/** Asks the chat screen to put `text` in the composer of the new chat. */
export function requestChatDraft(text: string): void {
  if (!text.trim()) return;
  lastId += 1;
  publish({ id: lastId, text });
}

/** Called by the chat screen once the text is in its composer, so it is applied once. */
export function consumeChatDraftRequest(id: number): void {
  if (pending?.id === id) publish(null);
}

/** The request waiting to be taken, if any. */
export function useChatDraftRequest(): ChatDraftRequest | null {
  return useSyncExternalStore(subscribe, currentRequest, currentRequest);
}
