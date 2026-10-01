import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import type { CanonicalChatClient, ChatCredentialOccurrence } from "../../lib/canonical-chat-client";
import { messageText } from "./canonical-chat-message-presentation";

const MARKER = /\[redacted(?: credential)?\]/g;
const MAX_METADATA_MESSAGE_IDS = 200;
const METADATA_BATCH_SIZE = 64;

interface DisclosureState {
  scopeKey: string | null;
  loaded: boolean;
  occurrences: ChatCredentialOccurrence[];
  values: Record<string, string>;
  unavailable: string[];
}

const EMPTY_STATE: DisclosureState = { scopeKey: null, loaded: false, occurrences: [], values: {}, unavailable: [] };

function occurrenceMatchesMessage(occurrence: ChatCredentialOccurrence, text: string | undefined): boolean {
  if (!text) return false;
  const marker = text.slice(occurrence.offset, occurrence.offset + occurrence.length);
  return marker === "[redacted]" || marker === "[redacted credential]";
}

export function useChatCredentialDisclosure({ client, detail, scopeKey }: {
  client: CanonicalChatClient;
  detail: CanonicalChatDetailResponse | null;
  /** Null while identity, private ownership, or connection is unavailable. */
  scopeKey: string | null;
}) {
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const [state, setState] = useState<DisclosureState>(EMPTY_STATE);
  const shown = state.scopeKey === scopeKey && scopeKey !== null ? state : EMPTY_STATE;
  const messages = detail?.messages ?? [];
  const candidates = messages.filter((message) => message.role === "assistant" && messageText(message).includes("[redacted"));
  const selected = candidates.slice(-MAX_METADATA_MESSAGE_IDS);
  const markerSignature = selected.map((message) => {
    const text = messageText(message);
    return `${message.id}:${message.state}:${[...text.matchAll(MARKER)].map((match) => match.index).join(",")}`;
  }).join("|");
  const selectedIds = selected.map((message) => message.id);
  const textById = new Map(selected.map((message) => [message.id, messageText(message)]));
  const chatId = detail?.record.chat.id;

  useLayoutEffect(() => {
    setState(EMPTY_STATE);
  }, [scopeKey]);

  useEffect(() => {
    if (!scopeKey || !chatId || selectedIds.length === 0) return;
    let cancelled = false;
    const requestedScope = scopeKey;
    const request = async () => {
      try {
        const batches: string[][] = [];
        for (let index = 0; index < selectedIds.length; index += METADATA_BATCH_SIZE) {
          batches.push(selectedIds.slice(index, index + METADATA_BATCH_SIZE));
        }
        const results = await Promise.all(batches.map((ids) => client.getCredentialOccurrences(chatId, ids)));
        if (cancelled || currentScope.current !== requestedScope) return;
        const occurrences = results.flat().filter((occurrence) => (
          occurrenceMatchesMessage(occurrence, textById.get(occurrence.messageId))
        ));
        setState((previous) => ({
          scopeKey: requestedScope,
          loaded: true,
          occurrences,
          values: previous.scopeKey === requestedScope ? Object.fromEntries(
            Object.entries(previous.values).filter(([id]) => occurrences.some((item) => item.id === id && item.revealed)),
          ) : {},
          unavailable: [],
        }));
        for (const occurrence of occurrences) {
          if (!occurrence.revealed) continue;
          try {
            const value = await client.getRevealedCredential(chatId, occurrence.id);
            if (cancelled || currentScope.current !== requestedScope) return;
            setState((previous) => previous.scopeKey === requestedScope && previous.occurrences.some((item) => item.id === occurrence.id && item.revealed)
              ? { ...previous, values: { ...previous.values, [occurrence.id]: value } } : previous);
          } catch {
            if (cancelled || currentScope.current !== requestedScope) return;
            setState((previous) => previous.scopeKey === requestedScope
              ? { ...previous, unavailable: [...new Set([...previous.unavailable, occurrence.id])] } : previous);
          }
        }
      } catch {
        if (cancelled || currentScope.current !== requestedScope) return;
        // Metadata failure never falls back to scanning or showing raw text.
        setState({ scopeKey: requestedScope, loaded: true, occurrences: [], values: {}, unavailable: [] });
      }
    };
    void request();
    return () => { cancelled = true; };
  // markerSignature is the complete, bounded selection key. A normal streaming
  // delta without a new placeholder need not re-request owner-only metadata.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, chatId, markerSignature, scopeKey]);

  const reveal = useCallback(async (occurrenceId: string) => {
    if (!scopeKey || !chatId || currentScope.current !== scopeKey) throw new Error("CredentialUnavailable");
    const value = await client.revealCredential(chatId, occurrenceId);
    if (currentScope.current !== scopeKey) return;
    setState((previous) => previous.scopeKey === scopeKey && previous.occurrences.some((item) => item.id === occurrenceId)
      ? { ...previous, occurrences: previous.occurrences.map((item) => item.id === occurrenceId ? { ...item, revealed: true } : item),
        values: { ...previous.values, [occurrenceId]: value }, unavailable: previous.unavailable.filter((id) => id !== occurrenceId) }
      : previous);
  }, [chatId, client, scopeKey]);

  const hide = useCallback(async (occurrenceId: string) => {
    if (!scopeKey || !chatId || currentScope.current !== scopeKey) throw new Error("CredentialUnavailable");
    setState((previous) => {
      if (previous.scopeKey !== scopeKey) return previous;
      const values = { ...previous.values };
      delete values[occurrenceId];
      // Invalidate a pending rehydration before the network hide completes.
      // The value must not reappear after the owner presses Hide.
      return { ...previous, values, occurrences: previous.occurrences.map((item) =>
        item.id === occurrenceId ? { ...item, revealed: false } : item) };
    });
    await client.hideCredential(chatId, occurrenceId);
    if (currentScope.current !== scopeKey) return;
    setState((previous) => previous.scopeKey === scopeKey
      ? { ...previous, occurrences: previous.occurrences.map((item) => item.id === occurrenceId ? { ...item, revealed: false } : item),
        unavailable: previous.unavailable.filter((id) => id !== occurrenceId) }
      : previous);
  }, [chatId, client, scopeKey]);

  return { ...shown, reveal, hide };
}
