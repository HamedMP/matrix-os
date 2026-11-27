import { randomUUID } from "../random-uuid.js";
import {
  CollaborationDiscussionMessageSchema,
  CollaborationDiscussionMessagesResponseSchema,
  type CollaborationDiscussionMessage,
  type CollaborationScope,
} from "@matrix-os/contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CollaborationApi } from "./ChatCollaboratorsDialog.js";
import { createDiscussionDraftStore, discussionDraftKey } from "./discussion-drafts.js";

function browserStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

function mergeNotes(current: CollaborationDiscussionMessage[], incoming: CollaborationDiscussionMessage[]) {
  const notes = [...current];
  for (const message of incoming) {
    if (!notes.some((note) => note.id === message.id)) notes.push(message);
  }
  return notes.sort((left, right) =>
      BigInt(left.sequence) < BigInt(right.sequence) ? -1 : BigInt(left.sequence) > BigInt(right.sequence) ? 1 : 0);
}

export function useSessionDiscussion(input: {
  api: CollaborationApi;
  scope: CollaborationScope;
  actorId: string;
  runtimeId: string;
  open: boolean;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}) {
  const store = useMemo(() => createDiscussionDraftStore(input.storage ?? browserStorage()), [input.storage]);
  const key = useMemo(() => discussionDraftKey({
    actorId: input.actorId,
    runtimeId: input.runtimeId,
    scopeId: input.scope.id,
  }), [input.actorId, input.runtimeId, input.scope.id]);
  const [messages, setMessages] = useState<CollaborationDiscussionMessage[]>([]);
  const [latestSequence, setLatestSequence] = useState("0");
  const [draftRecord, setDraftRecord] = useState(() => ({ key, text: store.load(key) }));
  const draft = draftRecord.key === key ? draftRecord.text : store.load(key);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const messagesRef = useRef<CollaborationDiscussionMessage[]>([]);
  const fetchedThroughRef = useRef("0");
  const latestSequenceRef = useRef("0");
  const pendingReadRef = useRef<{ generation: number; again: boolean; promise: Promise<void> } | null>(null);
  const base = `/api/collaboration/scopes/${encodeURIComponent(input.scope.id)}/discussion`;
  const identityRef = useRef(key);
  const identityGenerationRef = useRef(0);

  const load = useCallback((): Promise<void> => {
    if (identityRef.current !== key) return Promise.resolve();
    const requestKey = key;
    const requestGeneration = identityGenerationRef.current;
    const isCurrent = () => identityRef.current === requestKey
      && identityGenerationRef.current === requestGeneration;
    const active = pendingReadRef.current;
    if (active?.generation === requestGeneration) {
      active.again = true;
      return active.promise;
    }
    const request = { generation: requestGeneration, again: false, promise: Promise.resolve() };
    pendingReadRef.current = request;
    request.promise = (async () => {
      setLoading(true);
      try {
        do {
          request.again = false;
          // A locally displayed post is not a fetched page. Never let it skip unseen notes.
          const after = fetchedThroughRef.current;
          const page = CollaborationDiscussionMessagesResponseSchema.parse(
            await input.api.get(`${base}/messages?after=${encodeURIComponent(after)}&limit=100`),
          );
          if (!isCurrent()) return;
          const combined = mergeNotes(messagesRef.current, page.messages);
          fetchedThroughRef.current = page.messages.at(-1)?.sequence ?? after;
          if (BigInt(page.latestSequence) > BigInt(latestSequenceRef.current)) latestSequenceRef.current = page.latestSequence;
          messagesRef.current = combined;
          setMessages(combined);
          setLatestSequence(latestSequenceRef.current);
          setHasMore(BigInt(fetchedThroughRef.current) < BigInt(latestSequenceRef.current));
          setError(false);
          if (input.open && input.api.patch && fetchedThroughRef.current !== "0") {
            await input.api.patch(`${base}/user-state`, { readThroughSeq: fetchedThroughRef.current });
          }
        } while (isCurrent() && request.again);
      } catch (failure: unknown) {
        if (!isCurrent()) return;
        setError(true);
        // Let the stream retry rather than acknowledge an event whose read failed.
        throw failure;
      } finally {
        if (pendingReadRef.current === request) pendingReadRef.current = null;
        if (isCurrent()) setLoading(false);
      }
    })();
    return request.promise;
  }, [base, input.api, input.open, key]);

  const loadMore = useCallback(async () => {
    try { await load(); }
    catch (failure: unknown) {
      console.warn("[collaboration-discussion] load failed", failure instanceof Error ? failure.name : "UnknownError");
    }
  }, [load]);

  useLayoutEffect(() => {
    identityRef.current = key;
    identityGenerationRef.current += 1;
    messagesRef.current = [];
    fetchedThroughRef.current = "0";
    latestSequenceRef.current = "0";
    pendingReadRef.current = null;
    // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- private draft identity is a confidentiality boundary; synchronously adopt only the newly keyed persisted value before paint.
    setDraftRecord({ key, text: store.load(key) });
    // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- author/runtime/scope identity is the persistence boundary; old private notes must be cleared synchronously before the newly keyed async page is displayed.
    setMessages([]);
    // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- sequence belongs to the same identity boundary and is not derivable until the next validated page arrives.
    setLatestSequence("0");
    // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- pagination state belongs to the prior scope and must not leak while the next scope loads.
    setHasMore(false);
    setLoading(false);
    setSending(false);
    setError(false);
    return () => { identityGenerationRef.current += 1; };
  }, [key, store]);
  useEffect(() => { if (input.open) void loadMore(); }, [input.open, loadMore]);
  useEffect(() => {
    if (!input.open) return;
    const subscriptionKey = key;
    const subscriptionGeneration = identityGenerationRef.current;
    return input.api.subscribe?.(
      input.scope.id,
      load,
      () => {
        if (identityRef.current === subscriptionKey
          && identityGenerationRef.current === subscriptionGeneration) setError(true);
      },
    );
  }, [input.api, input.open, input.scope.id, key, load]);

  const setDraft = (text: string) => {
    setDraftRecord({ key, text });
    store.save(key, text);
  };
  const send = async () => {
    if (identityRef.current !== key || !input.scope.capabilities.discuss || !draft.trim() || sending) return;
    const requestKey = key;
    const requestGeneration = identityGenerationRef.current;
    const isCurrent = () => identityRef.current === requestKey
      && identityGenerationRef.current === requestGeneration;
    setSending(true);
    setError(false);
    try {
      const message = CollaborationDiscussionMessageSchema.parse(await input.api.post(`${base}/messages`, {
        clientRequestId: randomUUID(),
        expectedRevision: input.scope.revision,
        text: draft.trim(),
      }));
      store.clear(requestKey);
      if (!isCurrent()) return;
      const next = mergeNotes(messagesRef.current, [message]);
      messagesRef.current = next;
      setMessages(next);
      if (BigInt(message.sequence) > BigInt(latestSequenceRef.current)) latestSequenceRef.current = message.sequence;
      setLatestSequence(latestSequenceRef.current);
      setHasMore(BigInt(fetchedThroughRef.current) < BigInt(latestSequenceRef.current));
      setDraftRecord({ key: requestKey, text: "" });
      // Reconcile intervening notes even when this post's event is delayed or lost.
      void loadMore();
    } catch (failure: unknown) {
      if (!isCurrent()) return;
      console.warn("[collaboration-discussion] send failed", failure instanceof Error ? failure.name : "UnknownError");
      setError(true);
    } finally {
      if (isCurrent()) setSending(false);
    }
  };
  return { messages, latestSequence, draft, setDraft, loading, sending, error, hasMore, loadMore, send,
    readOnly: !input.scope.capabilities.discuss };
}
