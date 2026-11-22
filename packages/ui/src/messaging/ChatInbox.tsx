import { useEffect, useRef, useState } from "react";
import type {
  MessagingBridgeChangedEvent,
  MessagingBridgeConversation,
  MessagingBridgeMessage,
  MessagingBridgeNetwork,
} from "@matrix-os/contracts/messaging-bridge";
import { bridgeErrorText, isBridgeAbort, type MessagingBridgeClient } from "./bridge-client.js";
import {
  createClientTxnId,
  deriveThreadEntries,
  mergeConversations,
  mergeMessages,
  mergeRefreshedConversations,
  mergeRefreshedMessages,
  type ConversationFilter,
  type PendingSend,
} from "./bridge-view.js";
import { ConversationList, type ConversationListState } from "./ConversationList.js";
import { ConversationThread, type ThreadViewState } from "./ConversationThread.js";
import { useMessagingBridgeChanges, type MessagingBridgeSubscribe } from "./use-bridge-changes.js";

type ListState = ConversationListState;

interface ThreadState {
  roomId: string;
  items: MessagingBridgeMessage[];
  nextCursor?: string;
  loading: boolean;
  loadingOlder: boolean;
  error: string | null;
}

const EMPTY_LIST: ListState = { items: [], loading: true, loadingMore: false, error: null };

export interface ChatInboxProps {
  client: MessagingBridgeClient;
  networks: MessagingBridgeNetwork[];
  subscribe?: MessagingBridgeSubscribe;
  /** Whether the owner socket is live; `false` polls and refreshes on reconnect. */
  connected?: boolean;
  /** No linked account yet: the empty state points at linking. */
  hasAccounts?: boolean;
}

export function ChatInbox({ client, networks, subscribe, connected = true, hasAccounts = true }: ChatInboxProps) {
  const [filter, setFilter] = useState<ConversationFilter>("all");
  const [list, setList] = useState<ListState>(EMPTY_LIST);
  const [active, setActive] = useState<MessagingBridgeConversation | null>(null);
  const [thread, setThread] = useState<ThreadState | null>(null);
  const [pendingByRoom, setPendingByRoom] = useState<Record<string, PendingSend[]>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const listRequest = useRef<{ generation: number; controller: AbortController | null }>({ generation: 0, controller: null });
  const threadRequest = useRef<{ generation: number; controller: AbortController | null }>({ generation: 0, controller: null });
  const activeRoom = useRef<string | null>(null);

  useEffect(
    () => () => {
      listRequest.current.controller?.abort();
      threadRequest.current.controller?.abort();
    },
    [],
  );

  /** `mode: "replace"` resets the list (filter change); "refresh" merges page one; "more" appends. */
  const loadList = async (mode: "replace" | "refresh" | "more", nextFilter: ConversationFilter, cursor?: string) => {
    if (mode !== "more") listRequest.current.controller?.abort();
    const controller = new AbortController();
    const generation = mode === "more" ? listRequest.current.generation : listRequest.current.generation + 1;
    listRequest.current = { generation, controller };
    if (mode === "replace") setList(EMPTY_LIST);
    if (mode === "more") setList((prev) => ({ ...prev, loadingMore: true, error: null }));
    try {
      const page = await client.conversations(
        { ...(nextFilter === "all" ? {} : { network: nextFilter }), ...(cursor ? { cursor } : {}) },
        controller.signal,
      );
      if (listRequest.current.generation !== generation) return;
      setList((prev) => {
        const merged = mode === "replace"
          ? page
          : mode === "refresh"
            ? mergeRefreshedConversations(prev, page)
            : { items: mergeConversations(prev.items, page.items), nextCursor: page.nextCursor };
        return { items: merged.items, nextCursor: merged.nextCursor, loading: false, loadingMore: false, error: null };
      });
    } catch (error: unknown) {
      if (isBridgeAbort(error) || listRequest.current.generation !== generation) return;
      setList((prev) => ({ ...prev, loading: false, loadingMore: false, error: bridgeErrorText(error) }));
    }
  };

  const loadThread = async (roomId: string, mode: "open" | "refresh" | "older", cursor?: string) => {
    if (mode === "older" && !cursor) return;
    if (mode !== "older") threadRequest.current.controller?.abort();
    const controller = new AbortController();
    const generation = mode === "older" ? threadRequest.current.generation : threadRequest.current.generation + 1;
    threadRequest.current = { generation, controller };
    if (mode === "open") setThread({ roomId, items: [], loading: true, loadingOlder: false, error: null });
    if (mode === "older") setThread((prev) => (prev && prev.roomId === roomId ? { ...prev, loadingOlder: true, error: null } : prev));
    try {
      const page = await client.messages(roomId, cursor ? { cursor } : {}, controller.signal);
      if (threadRequest.current.generation !== generation || activeRoom.current !== roomId) return;
      setThread((prev) => {
        const base = prev && prev.roomId === roomId ? prev : { roomId, items: [], loading: false, loadingOlder: false, error: null };
        const merged = mode === "refresh"
          ? mergeRefreshedMessages(base, page)
          : { items: mergeMessages(base.items, page.items), nextCursor: page.nextCursor };
        return { roomId, items: merged.items, nextCursor: merged.nextCursor, loading: false, loadingOlder: false, error: null };
      });
    } catch (error: unknown) {
      if (isBridgeAbort(error) || threadRequest.current.generation !== generation || activeRoom.current !== roomId) return;
      setThread((prev) => (prev && prev.roomId === roomId ? { ...prev, loading: false, loadingOlder: false, error: bridgeErrorText(error) } : prev));
    }
  };

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- one bootstrap read of page one on mount, bounded by the client's 10 s timeout and aborted on unmount; later reads are driven by user actions and owner-socket change events
  useEffect(() => {
    void loadList("replace", "all");
    // react-doctor-disable-next-line react-doctor/exhaustive-deps -- mount-only bootstrap; loadList reads refs and the client, which is fixed for this mount
  }, []);

  useMessagingBridgeChanges(subscribe, (event: MessagingBridgeChangedEvent | null) => {
    void loadList("refresh", filter);
    const roomId = activeRoom.current;
    if (!roomId) return;
    if (event === null || (event.scope === "messages" && (!event.roomId || event.roomId === roomId))) {
      void loadThread(roomId, "refresh");
    }
  }, true, connected);

  const chooseFilter = (next: ConversationFilter) => {
    if (next === filter) return;
    setFilter(next);
    void loadList("replace", next);
  };

  const openConversation = (conversation: MessagingBridgeConversation) => {
    activeRoom.current = conversation.roomId;
    setActive(conversation);
    void loadThread(conversation.roomId, "open");
  };

  const closeConversation = () => {
    activeRoom.current = null;
    threadRequest.current.controller?.abort();
    threadRequest.current = { generation: threadRequest.current.generation + 1, controller: null };
    setActive(null);
    setThread(null);
  };

  /** Inserts or updates one local send; `null` removes it. */
  const setPendingSend = (roomId: string, clientTxnId: string, next: PendingSend | null) => {
    setPendingByRoom((prev) => {
      const current = prev[roomId] ?? [];
      if (!next) return { ...prev, [roomId]: current.filter((item) => item.clientTxnId !== clientTxnId) };
      const exists = current.some((item) => item.clientTxnId === clientTxnId);
      return { ...prev, [roomId]: exists ? current.map((item) => (item.clientTxnId === clientTxnId ? next : item)) : [...current, next] };
    });
  };

  const deliver = async (roomId: string, pending: PendingSend) => {
    setPendingSend(roomId, pending.clientTxnId, { ...pending, state: "sending" });
    try {
      const sent = await client.send(roomId, { body: pending.body, clientTxnId: pending.clientTxnId });
      if (sent.delivery === "failed") {
        setPendingSend(roomId, pending.clientTxnId, { ...pending, state: "failed" });
        return;
      }
      if (activeRoom.current === roomId) {
        setThread((prev) => (prev && prev.roomId === roomId ? { ...prev, items: mergeMessages(prev.items, [sent]) } : prev));
      }
      // The server now holds this message; the thread shows its copy from here on.
      setPendingSend(roomId, pending.clientTxnId, null);
    } catch (error: unknown) {
      console.warn("[messaging] Send failed", error instanceof Error ? error.name : "UnknownError");
      setPendingSend(roomId, pending.clientTxnId, { ...pending, state: "failed" });
    }
  };

  const send = (roomId: string) => {
    const body = (drafts[roomId] ?? "").trim();
    if (!body) return;
    setDrafts((prev) => ({ ...prev, [roomId]: "" }));
    void deliver(roomId, { clientTxnId: createClientTxnId(), body, state: "sending", createdAt: new Date().toISOString() });
  };

  const activeRoomId = active?.roomId ?? null;
  const activeConversation = active ? (list.items.find((item) => item.roomId === active.roomId) ?? active) : null;
  if (activeRoomId && activeConversation) {
    const serverItems = thread?.roomId === activeRoomId ? thread.items : [];
    return (
      <div className="ph-no-capture">
        <ConversationThread
          conversation={activeConversation}
          entries={deriveThreadEntries(serverItems, pendingByRoom[activeRoomId] ?? [])}
          view={threadView(thread, activeRoomId)}
          draft={drafts[activeRoomId] ?? ""}
          onDraftChange={(value) => setDrafts((prev) => ({ ...prev, [activeRoomId]: value }))}
          onSend={() => send(activeRoomId)}
          onRetry={(pending) => { void deliver(activeRoomId, pending); }}
          onBack={closeConversation}
          onLoadOlder={() => { void loadThread(activeRoomId, "older", thread?.nextCursor); }}
          onReload={() => { void loadThread(activeRoomId, "open"); }}
        />
      </div>
    );
  }

  return (
    <ConversationList
      networks={networks}
      hasAccounts={hasAccounts}
      filter={filter}
      list={list}
      onFilter={chooseFilter}
      onOpen={openConversation}
      onRetry={() => { void loadList("replace", filter); }}
      onMore={() => { void loadList("more", filter, list.nextCursor); }}
    />
  );
}

function threadView(thread: ThreadState | null, roomId: string): ThreadViewState {
  if (thread?.roomId !== roomId) return { loading: true, loadingOlder: false, error: null, hasOlder: false };
  return { loading: thread.loading, loadingOlder: thread.loadingOlder, error: thread.error, hasOlder: Boolean(thread.nextCursor) };
}
