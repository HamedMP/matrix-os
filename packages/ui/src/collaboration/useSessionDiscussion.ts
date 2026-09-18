import {
  CollaborationDiscussionMessageSchema,
  CollaborationDiscussionMessagesResponseSchema,
  type CollaborationDiscussionMessage,
  type CollaborationScope,
} from "@matrix-os/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  const [hasMore, setHasMore] = useState(false);
  const messagesRef = useRef<CollaborationDiscussionMessage[]>([]);
  const loadingRef = useRef(false);
  const store = useMemo(() => createDiscussionDraftStore(input.storage ?? browserStorage()), [input.storage]);
  const key = useMemo(() => discussionDraftKey({
    actorId: input.actorId,
    runtimeId: input.runtimeId,
    scopeId: input.scope.id,
  }), [input.actorId, input.runtimeId, input.scope.id]);
  const base = `/api/collaboration/scopes/${encodeURIComponent(input.scope.id)}/discussion`;

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const after = messagesRef.current.at(-1)?.sequence ?? "0";
      const page = CollaborationDiscussionMessagesResponseSchema.parse(
        await input.api.get(`${base}/messages?after=${encodeURIComponent(after)}&limit=100`),
      );
      const parsed = page.messages.map((message) => CollaborationDiscussionMessageSchema.parse(message));
      const combined = parsed.reduce<CollaborationDiscussionMessage[]>((current, message) => (
        current.some((item) => item.id === message.id) ? current : [...current, message]
      ), messagesRef.current);
      messagesRef.current = combined;
      setMessages(combined);
      setLatestSequence(page.latestSequence);
      const displayedThrough = combined.at(-1)?.sequence ?? "0";
      setHasMore(BigInt(displayedThrough) < BigInt(page.latestSequence));
      setError(false);
      if (input.open && input.api.patch && displayedThrough !== "0") {
        await input.api.patch(`${base}/user-state`, { readThroughSeq: displayedThrough });
      }
    } catch (failure: unknown) {
      console.warn("[collaboration-discussion] load failed", failure instanceof Error ? failure.name : "UnknownError");
      setError(true);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [base, input.api, input.open]);

  useEffect(() => { setDraftState(store.load(key)); }, [key, store]);
  useEffect(() => {
    messagesRef.current = [];
    // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- author/runtime/scope identity is the persistence boundary; old private notes must be cleared synchronously before the newly keyed async page is displayed.
    setMessages([]);
    // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- sequence belongs to the same identity boundary and is not derivable until the next validated page arrives.
    setLatestSequence("0");
    // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- pagination state belongs to the prior scope and must not leak while the next scope loads.
    setHasMore(false);
  }, [key]);
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
      const displayedThrough = BigInt(messagesRef.current.at(-1)?.sequence ?? "0");
      const messageSequence = BigInt(message.sequence);
      const canAppend = messageSequence === displayedThrough + BigInt(1);
      const next = messagesRef.current.some((item) => item.id === message.id) || !canAppend
        ? messagesRef.current
        : [...messagesRef.current, message];
      messagesRef.current = next;
      setMessages(next);
      setLatestSequence(message.sequence);
      setHasMore(BigInt(next.at(-1)?.sequence ?? "0") < messageSequence);
      setDraftState("");
      store.clear(key);
    } catch (failure: unknown) {
      console.warn("[collaboration-discussion] send failed", failure instanceof Error ? failure.name : "UnknownError");
      setError(true);
    } finally {
      setSending(false);
    }
  };
  return { messages, latestSequence, draft, setDraft, loading, sending, error, hasMore, loadMore: load, send,
    readOnly: !input.scope.capabilities.discuss };
}
