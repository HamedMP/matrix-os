import {
  CollaborationDiscussionMessageSchema,
  CollaborationDiscussionMessagesResponseSchema,
  type CollaborationDiscussionMessage,
  type CollaborationScope,
} from "@matrix-os/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CollaborationApi } from "./ChatCollaboratorsDialog.js";
import { createDiscussionDraftStore, discussionDraftKey } from "./discussion-drafts.js";

function browserStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

export function useSessionDiscussion(input: {
  api: CollaborationApi;
  scope: CollaborationScope;
  actorId: string;
  runtimeId: string;
  open: boolean;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}) {
  const [messages, setMessages] = useState<CollaborationDiscussionMessage[]>([]);
  const [latestSequence, setLatestSequence] = useState("0");
  const [draft, setDraftState] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(false);
  const store = useMemo(() => createDiscussionDraftStore(input.storage ?? browserStorage()), [input.storage]);
  const key = useMemo(() => discussionDraftKey({
    actorId: input.actorId,
    runtimeId: input.runtimeId,
    scopeId: input.scope.id,
  }), [input.actorId, input.runtimeId, input.scope.id]);
  const base = `/api/collaboration/scopes/${encodeURIComponent(input.scope.id)}/discussion`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = CollaborationDiscussionMessagesResponseSchema.parse(
        await input.api.get(`${base}/messages?after=0&limit=100`),
      );
      setMessages(page.messages.map((message) => CollaborationDiscussionMessageSchema.parse(message)));
      setLatestSequence(page.latestSequence);
      setError(false);
      if (input.open && input.api.patch) {
        await input.api.patch(`${base}/user-state`, { readThroughSeq: page.latestSequence });
      }
    } catch (failure: unknown) {
      console.warn("[collaboration-discussion] load failed", failure instanceof Error ? failure.name : "UnknownError");
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [base, input.api, input.open]);

  useEffect(() => { setDraftState(store.load(key)); }, [key, store]);
  useEffect(() => { if (input.open) void load(); }, [input.open, load]);
  useEffect(() => {
    if (!input.open) return;
    return input.api.subscribe?.(
      input.scope.id,
      load,
      () => setError(true),
    );
  }, [input.api, input.open, input.scope.id, load]);

  const setDraft = (text: string) => {
    setDraftState(text);
    store.save(key, text);
  };
  const send = async () => {
    if (!input.scope.capabilities.discuss || !draft.trim() || sending) return;
    setSending(true);
    setError(false);
    try {
      const message = CollaborationDiscussionMessageSchema.parse(await input.api.post(`${base}/messages`, {
        clientRequestId: crypto.randomUUID(),
        expectedRevision: input.scope.revision,
        text: draft.trim(),
      }));
      setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message]);
      setLatestSequence(message.sequence);
      setDraftState("");
      store.clear(key);
    } catch (failure: unknown) {
      console.warn("[collaboration-discussion] send failed", failure instanceof Error ? failure.name : "UnknownError");
      setError(true);
    } finally {
      setSending(false);
    }
  };
  return { messages, latestSequence, draft, setDraft, loading, sending, error, send,
    readOnly: !input.scope.capabilities.discuss };
}
