import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { BotCreationSnapshot, BotDraftProposal, CanonicalProviderCatalog } from "@matrix-os/contracts";
import {
  createCreationConversation, creationConversationSelection,
  type CreationConversationClient, type CreationConversationState
} from "./creation-conversation.js";

/** Host composers and transcripts share the same genuine conversation orchestration. */
export function useCreationConversation(options: {
  client: CreationConversationClient | null;
  snapshot: BotCreationSnapshot;
  ready: boolean;
  catalog: CanonicalProviderCatalog | null;
  onProposal(proposal: BotDraftProposal): boolean;
}) {
  const [draftText, setDraftText] = useState<{ conversation: ReturnType<typeof createCreationConversation> | null; text: string } | null>(null);
  const [observed, setObserved] = useState<{ conversation: ReturnType<typeof createCreationConversation>; state: CreationConversationState } | null>(null);
  const sessionId = options.snapshot.sessionId;
  const client = options.client;
  const session = useMemo(() => {
    if (!client) return null;
    let currentOptions: typeof options | null = null;
    const instance: ReturnType<typeof createCreationConversation> = createCreationConversation({
      client, sessionId,
      isCurrent: () => Boolean(currentOptions?.client === client && currentOptions.snapshot.sessionId === sessionId),
      canAdmit: () => currentOptions?.ready === true,
      onProposal: proposal => currentOptions?.onProposal(proposal) ?? false,
      onChange: state => setObserved({ conversation: instance, state }),
    });
    return { conversation: instance, update: (next: typeof options) => { currentOptions = next; }, options: () => currentOptions };
  }, [client, sessionId]);
  const conversation = session?.conversation ?? null;
  const state: CreationConversationState = observed?.conversation === conversation ? observed.state : { detail: null, busy: false, error: "", activeRunId: null, question: null, questions: [] };
  useLayoutEffect(() => { session?.update(options); }, [session, options]);
  useLayoutEffect(() => {
    conversation?.activate();
    return () => conversation?.dispose();
  }, [conversation]);
  useEffect(() => {
    if (!conversation || !state.busy || !state.activeRunId) return;
    void conversation.refresh();
    const timer = setInterval(() => { void conversation.refresh(); }, 1000);
    return () => clearInterval(timer);
  }, [conversation, state.busy, state.activeRunId]);
  const selection = creationConversationSelection(options.catalog);
  const available = Boolean(options.ready && conversation && selection && !state.accessLost);
  useEffect(() => {
    const active = session?.options();
    const model = creationConversationSelection(active?.catalog ?? null);
    if (available && active && model) void conversation?.open(active.snapshot, model);
  }, [available, session, conversation]);

  return {
    ...state, text: draftText?.conversation === conversation ? draftText?.text ?? "" : "",
    setText: (value: string) => { if (conversation?.isCurrent()) setDraftText({ conversation, text: value }); },
    available,
    send: async (value: string) => {
      const currentOptions = session?.options();
      const currentSelection = creationConversationSelection(currentOptions?.catalog ?? null);
      return conversation && currentOptions && currentSelection ? conversation.send(value, { ...currentOptions.snapshot, intent: "reply" }, currentSelection) : false;
    },
    answer: async (value: string) => {
      const active = session?.options();
      const model = creationConversationSelection(active?.catalog ?? null);
      return Boolean(conversation && active && model && await conversation.replyToQuestion(value, active.snapshot, model));
    },
    retry: async () => { await conversation?.retry(); },
    abort: async () => { await conversation?.abort(); },
    refresh: async () => { await conversation?.refresh(true); },
  };
}
