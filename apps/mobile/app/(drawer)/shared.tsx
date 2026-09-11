import AsyncStorage from "@react-native-async-storage/async-storage";
import { useAuth } from "@clerk/clerk-expo";
import {
  CollaborationDiscoveryItemSchema,
  CollaborationEventFrameSchema,
  CollaborationInvitationSchema,
  CollaborationScopeSchema,
  CollaborationSharedChatMessageSchema,
  CollaborationChatSchema,
} from "@matrix-os/contracts/collaboration";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View,
  type ListRenderItemInfo } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { z } from "zod/v4";
import { renderChatMarkdown, type ChatMarkdownTheme } from "@/lib/chat-markdown";
import { loadCollaborationDraft, saveCollaborationDraft } from "@/lib/collaboration-drafts";
import {
  acceptCollaborationInvitation,
  collaborationEventsUrl,
  fetchCollaborationInbox,
  fetchCollaborationInvitation,
  fetchCollaborationEventTicket,
  fetchCollaborationScope,
  fetchSharedChat,
  fetchSharedChatMessages,
  fetchSharedCollaborations,
  postSharedChatDiscussion,
  updateSharedChatReadState,
} from "@/lib/requests/collaboration";

type DiscoveryItem = z.infer<typeof CollaborationDiscoveryItemSchema>;
type Invitation = z.infer<typeof CollaborationInvitationSchema>;
type Scope = z.infer<typeof CollaborationScopeSchema>;
type Chat = z.infer<typeof CollaborationChatSchema>;
type Message = z.infer<typeof CollaborationSharedChatMessageSchema>;
type ViewState = { kind: "home" } | { kind: "invitation"; invitation: Invitation } | { kind: "chat"; scopeId: string };
type ScreenState = {
  view: ViewState;
  items: DiscoveryItem[];
  inboxCursor: string | null;
  sharedCursor: string | null;
  loadingMoreItems: boolean;
  paginationError: string;
  scope: Scope | null;
  chat: Chat | null;
  messages: Message[];
  hasMoreMessages: boolean;
  loadingMoreMessages: boolean;
  draft: string;
  loading: boolean;
  sending: boolean;
  error: string;
};

const initialState: ScreenState = {
  view: { kind: "home" },
  items: [],
  inboxCursor: null,
  sharedCursor: null,
  loadingMoreItems: false,
  paginationError: "",
  scope: null,
  chat: null,
  messages: [],
  hasMoreMessages: false,
  loadingMoreMessages: false,
  draft: "",
  loading: true,
  sending: false,
  error: "",
};

type ScreenAction =
  | { type: "patch"; patch: Partial<ScreenState> }
  | { type: "append_items"; additions: DiscoveryItem[]; inboxCursor?: string | null; sharedCursor?: string | null };

function screenReducer(state: ScreenState, action: ScreenAction): ScreenState {
  if (action.type === "patch") return { ...state, ...action.patch };
  const items = action.additions.reduce<DiscoveryItem[]>((combined, item) => (
    combined.some((existing) => discoveryKey(existing) === discoveryKey(item)) ? combined : [...combined, item]
  ), state.items);
  return {
    ...state,
    items,
    ...(action.inboxCursor === undefined ? {} : { inboxCursor: action.inboxCursor }),
    ...(action.sharedCursor === undefined ? {} : { sharedCursor: action.sharedCursor }),
  };
}

export default function SharedScreen() {
  const { getToken, userId } = useAuth();
  const getTokenRef = useRef(getToken);
  useEffect(() => { getTokenRef.current = getToken; }, [getToken]);
  const { theme } = useUnistyles();
  const [state, dispatch] = useReducer(screenReducer, initialState);
  const { view, inboxCursor, sharedCursor, loadingMoreItems, scope, chat, messages,
    loadingMoreMessages, draft } = state;
  const chatLoadGeneration = useRef(0);
  const latestSequenceRef = useRef("0");
  const eventSequenceRef = useRef("0");
  const eventScopeRef = useRef<string | null>(null);
  const chatRef = useRef<Chat | null>(null);
  const messagesRef = useRef<Message[]>([]);
  const token = useCallback(async () => {
    const value = await getTokenRef.current();
    if (!value) throw new Error("CollaborationUnavailable");
    return value;
  }, []);
  const loadHome = useCallback(async () => {
    dispatch({ type: "patch", patch: { loading: true, error: "" } });
    try {
      const actorToken = await token();
      const [inbox, shared] = await Promise.all([
        fetchCollaborationInbox(actorToken), fetchSharedCollaborations(actorToken),
      ]);
      dispatch({ type: "patch", patch: {
        items: [...inbox.items, ...shared.items],
        inboxCursor: inbox.nextCursor ?? null,
        sharedCursor: shared.nextCursor ?? null,
        paginationError: "",
      } });
    } catch (failure: unknown) {
      console.warn("[mobile-collaboration] discovery failed", failure instanceof Error ? failure.name : "UnknownError");
      dispatch({ type: "patch", patch: { error: "Shared Chats are unavailable. Pull down or return later to try again." } });
    } finally { dispatch({ type: "patch", patch: { loading: false } }); }
  }, [token]);
  useEffect(() => { void loadHome(); }, [loadHome]);
  const loadMoreItems = async () => {
    if (loadingMoreItems || (!inboxCursor && !sharedCursor)) return;
    dispatch({ type: "patch", patch: { loadingMoreItems: true, paginationError: "" } });
    try {
      const actorToken = await token();
      const [inbox, shared] = await Promise.all([
        inboxCursor ? fetchCollaborationInbox(actorToken, inboxCursor) : null,
        sharedCursor ? fetchSharedCollaborations(actorToken, sharedCursor) : null,
      ]);
      const additions = [...(inbox?.items ?? []), ...(shared?.items ?? [])];
      dispatch({ type: "append_items", additions,
        ...(inbox ? { inboxCursor: inbox.nextCursor ?? null } : {}),
        ...(shared ? { sharedCursor: shared.nextCursor ?? null } : {}),
      });
    } catch (failure: unknown) {
      console.warn("[mobile-collaboration] discovery page failed", failure instanceof Error ? failure.name : "UnknownError");
      dispatch({ type: "patch", patch: { paginationError: "More shared items could not be loaded. Try again." } });
    } finally { dispatch({ type: "patch", patch: { loadingMoreItems: false } }); }
  };
  const loadChat = useCallback(async (scopeId: string) => {
    const generation = ++chatLoadGeneration.current;
    if (eventScopeRef.current !== scopeId) {
      eventScopeRef.current = scopeId;
      eventSequenceRef.current = "0";
      latestSequenceRef.current = "0";
      chatRef.current = null;
      messagesRef.current = [];
    }
    dispatch({ type: "patch", patch: {
      loading: true,
      error: "",
      view: { kind: "chat", scopeId },
      scope: null,
      chat: null,
      messages: [],
      draft: "",
      hasMoreMessages: false,
      loadingMoreMessages: false,
    } });
    try {
      const actorToken = await token();
      const [nextScope, nextChat, history] = await Promise.all([
        fetchCollaborationScope(actorToken, scopeId),
        fetchSharedChat(actorToken, scopeId),
        fetchSharedChatMessages(actorToken, scopeId),
      ]);
      const nextDraft = await loadCollaborationDraft(AsyncStorage, { actorId: userId, scopeId, chatId: nextChat.id });
      if (generation !== chatLoadGeneration.current) return;
      chatRef.current = nextChat;
      messagesRef.current = history.messages;
      latestSequenceRef.current = history.messages.at(-1)?.sequence ?? "0";
      dispatch({ type: "patch", patch: {
        scope: nextScope,
        chat: nextChat,
        messages: history.messages,
        hasMoreMessages: BigInt(nextChat.messageCount) > BigInt(history.messages.length),
        draft: nextDraft,
      } });
      const sequence = history.messages.at(-1)?.sequence;
      if (sequence) void updateSharedChatReadState(actorToken, scopeId, sequence).catch((failure: unknown) => {
        console.warn("[mobile-collaboration] read state failed", failure instanceof Error ? failure.name : "UnknownError");
      });
    } catch (failure: unknown) {
      console.warn("[mobile-collaboration] Chat load failed", failure instanceof Error ? failure.name : "UnknownError");
      if (generation === chatLoadGeneration.current) {
        dispatch({ type: "patch", patch: { error: "This shared Chat is unavailable. Your access may have changed." } });
      }
    } finally {
      if (generation === chatLoadGeneration.current) dispatch({ type: "patch", patch: { loading: false } });
    }
  }, [token, userId]);
  const loadMoreMessages = async () => {
    if (view.kind !== "chat" || !chat || loadingMoreMessages) return;
    const after = messages.at(-1)?.sequence;
    if (!after) return;
    const generation = chatLoadGeneration.current;
    dispatch({ type: "patch", patch: { loadingMoreMessages: true, error: "" } });
    try {
      const page = await fetchSharedChatMessages(await token(), view.scopeId, after);
      if (generation !== chatLoadGeneration.current) return;
      const currentChat = chatRef.current;
      if (!currentChat) return;
      const currentMessages = messagesRef.current;
      const appended = page.messages.filter((message) => !currentMessages.some((existing) => existing.id === message.id));
      const combined = [...currentMessages, ...appended];
      messagesRef.current = combined;
      latestSequenceRef.current = combined.at(-1)?.sequence ?? latestSequenceRef.current;
      dispatch({ type: "patch", patch: {
        messages: combined,
        hasMoreMessages: appended.length > 0 && BigInt(currentChat.messageCount) > BigInt(combined.length),
      } });
    } catch (failure: unknown) {
      console.warn("[mobile-collaboration] history page failed", failure instanceof Error ? failure.name : "UnknownError");
      if (generation === chatLoadGeneration.current) {
        dispatch({ type: "patch", patch: { error: "More messages could not be loaded. Try again." } });
      }
    } finally {
      if (generation === chatLoadGeneration.current) {
        dispatch({ type: "patch", patch: { loadingMoreMessages: false } });
      }
    }
  };
  const refreshLiveChat = useCallback(async (scopeId: string) => {
    const generation = ++chatLoadGeneration.current;
    const actorToken = await token();
    const [nextScope, nextChat] = await Promise.all([
      fetchCollaborationScope(actorToken, scopeId),
      fetchSharedChat(actorToken, scopeId),
    ]);
    let combined = messagesRef.current;
    const targetCount = BigInt(nextChat.messageCount);
    while (BigInt(combined.length) < targetCount) {
      const page = await fetchSharedChatMessages(actorToken, scopeId, combined.at(-1)?.sequence ?? "0");
      const additions = page.messages.filter((message) => !combined.some((existing) => existing.id === message.id));
      if (additions.length === 0) throw new Error("CollaborationRecoveryIncomplete");
      combined = [...combined, ...additions];
    }
    if (generation !== chatLoadGeneration.current || eventScopeRef.current !== scopeId) {
      throw new CollaborationRecoverySupersededError();
    }
    chatRef.current = nextChat;
    messagesRef.current = combined;
    latestSequenceRef.current = combined.at(-1)?.sequence ?? latestSequenceRef.current;
    dispatch({ type: "patch", patch: {
      scope: nextScope,
      chat: nextChat,
      messages: combined,
      hasMoreMessages: BigInt(nextChat.messageCount) > BigInt(combined.length),
      loading: false,
    } });
    const sequence = combined.at(-1)?.sequence;
    if (sequence) void updateSharedChatReadState(actorToken, scopeId, sequence).catch((failure: unknown) => {
      console.warn("[mobile-collaboration] realtime read state failed", failure instanceof Error ? failure.name : "UnknownError");
    });
  }, [token]);
  const activeScopeId = view.kind === "chat" ? view.scopeId : null;
  useEffect(() => {
    if (!activeScopeId) return;
    let closed = false;
    let socket: WebSocket | null = null;
    let retryTimer: RetryTimer | null = null;
    let attempt = 0;
    const retry = (connect: () => Promise<void>) => {
      const delay = Math.min(10_000, 500 * (2 ** Math.min(attempt, 5)));
      attempt += 1;
      retryTimer?.cancel();
      retryTimer = createRetryTimer(() => { void connect(); }, delay);
    };
    const connect = async () => {
      try {
        const actorToken = await token();
        const ticket = await fetchCollaborationEventTicket(actorToken, activeScopeId, randomUuid());
        if (closed) return;
        const NativeWebSocket = WebSocket as unknown as new (
          target: string,
          protocols?: string | string[],
          options?: { headers: Record<string, string> },
        ) => WebSocket;
        const next = new NativeWebSocket(
          collaborationEventsUrl(activeScopeId, ticket.ticket, eventSequenceRef.current),
          undefined,
          { headers: { Authorization: `Bearer ${actorToken}` } },
        );
        socket = next;
        let usable = true;
        let refreshQueue = Promise.resolve();
        const enqueueAfterRecovery = (operation: () => void | Promise<void>) => {
          refreshQueue = refreshQueue.then(async () => {
            if (!usable || closed) return;
            await operation();
          }).catch((failure: unknown) => {
            if (failure instanceof CollaborationRecoverySupersededError) return;
            console.warn("[mobile-collaboration] realtime refresh failed", failure instanceof Error ? failure.name : "UnknownError");
            if (!closed && eventScopeRef.current === activeScopeId) {
              dispatch({ type: "patch", patch: { error: "This shared Chat could not be refreshed. Try again." } });
            }
            if (usable && !closed) {
              usable = false;
              next.close(1011, "Refresh failed");
            }
          });
        };
        next.onopen = () => { attempt = 0; };
        next.onmessage = (event) => {
          if (!usable) return;
          if (typeof event.data !== "string" || event.data.length > 64 * 1024) {
            next.close(1008, "Invalid frame");
            return;
          }
          try {
            const frame = CollaborationEventFrameSchema.parse(JSON.parse(event.data) as unknown);
            if (frame.scopeId !== activeScopeId) throw new Error("ScopeMismatch");
            if (frame.type === "heartbeat") {
              if (next.readyState === WebSocket.OPEN) next.send(JSON.stringify({ version: 1, type: "heartbeat" }));
              enqueueAfterRecovery(() => { eventSequenceRef.current = frame.sequence; });
            } else if (frame.type === "ready") {
              enqueueAfterRecovery(() => { eventSequenceRef.current = frame.sequence; });
            } else if (frame.type === "unavailable") {
              closed = true;
              chatLoadGeneration.current += 1;
              eventScopeRef.current = null;
              chatRef.current = null;
              messagesRef.current = [];
              latestSequenceRef.current = "0";
              dispatch({ type: "patch", patch: {
                scope: null,
                chat: null,
                messages: [],
                hasMoreMessages: false,
                loadingMoreMessages: false,
                draft: "",
                loading: false,
                error: "This shared Chat is unavailable. Your access may have changed.",
              } });
              next.close(1008, "Unavailable");
            } else if (frame.type === "changed" || frame.type === "capabilities_changed" || frame.type === "refresh_required") {
              enqueueAfterRecovery(async () => {
                await refreshLiveChat(activeScopeId);
                if (usable && !closed) eventSequenceRef.current = frame.sequence;
              });
            }
          } catch (failure: unknown) {
            console.warn("[mobile-collaboration] event frame rejected", failure instanceof Error ? failure.name : "UnknownError");
            next.close(1008, "Invalid frame");
          }
        };
        next.onerror = () => next.close();
        next.onclose = () => {
          usable = false;
          if (socket === next) socket = null;
          if (closed) return;
          retry(connect);
        };
      } catch (failure: unknown) {
        console.warn("[mobile-collaboration] event connection failed", failure instanceof Error ? failure.name : "UnknownError");
        if (closed) return;
        retry(connect);
      }
    };
    void connect();
    return () => {
      closed = true;
      if (eventScopeRef.current === activeScopeId) eventScopeRef.current = null;
      retryTimer?.cancel();
      socket?.close(1000, "Closed");
    };
  }, [activeScopeId, refreshLiveChat, token]);
  const review = async (invitationId: string) => {
    dispatch({ type: "patch", patch: { loading: true, error: "" } });
    try { dispatch({ type: "patch", patch: { view: { kind: "invitation", invitation: await fetchCollaborationInvitation(await token(), invitationId) } } }); }
    catch (failure: unknown) {
      console.warn("[mobile-collaboration] invitation load failed", failure instanceof Error ? failure.name : "UnknownError");
      dispatch({ type: "patch", patch: { error: "This invitation is unavailable." } });
    } finally { dispatch({ type: "patch", patch: { loading: false } }); }
  };
  const accept = async (invitation: Invitation) => {
    dispatch({ type: "patch", patch: { loading: true, error: "" } });
    try {
      const result = await acceptCollaborationInvitation(await token(), invitation.id, invitation.revision, randomUuid());
      await loadChat(result.scopeId);
    } catch (failure: unknown) {
      console.warn("[mobile-collaboration] invitation acceptance failed", failure instanceof Error ? failure.name : "UnknownError");
      dispatch({ type: "patch", patch: { error: "Invitation could not be accepted. Try again.", loading: false } });
    }
  };
  const updateDraft = (text: string) => {
    dispatch({ type: "patch", patch: { draft: text } });
    if (!chat || view.kind !== "chat") return;
    void saveCollaborationDraft(AsyncStorage, {
      actorId: userId, scopeId: view.scopeId, chatId: chat.id, text,
    }).catch((failure: unknown) => {
      console.warn("[mobile-collaboration] draft save failed", failure instanceof Error ? failure.name : "UnknownError");
    });
  };
  const send = async () => {
    if (!scope || !chat || view.kind !== "chat" || !draft.trim() || !scope.capabilities.discuss) return;
    dispatch({ type: "patch", patch: { sending: true, error: "" } });
    try {
      await postSharedChatDiscussion(await token(), view.scopeId, scope.revision, draft.trim(), randomUuid());
      await saveCollaborationDraft(AsyncStorage, { actorId: userId, scopeId: view.scopeId, chatId: chat.id, text: "" });
      dispatch({ type: "patch", patch: { draft: "" } });
      await loadChat(view.scopeId);
    } catch (failure: unknown) {
      console.warn("[mobile-collaboration] discussion send failed", failure instanceof Error ? failure.name : "UnknownError");
      dispatch({ type: "patch", patch: { error: "Message was not sent. Your draft is still here—try again." } });
    } finally { dispatch({ type: "patch", patch: { sending: false } }); }
  };
  const markdownTheme = useMemo(() => ({
    textStyle: { color: theme.v2.appColors.ink, fontFamily: theme.v2.fonts.body, fontSize: 15, lineHeight: 22 },
    mutedColor: theme.v2.appColors.muted, linkColor: theme.v2.colors.action,
    codeBackground: theme.v2.appColors.soft, codeBorderColor: theme.v2.colors.borderSubtle,
    monoFontFamily: theme.v2.fonts.mono, boldFontFamily: theme.v2.fonts.semibold, headingFontFamily: theme.v2.fonts.display,
  }), [theme]);

  if (view.kind === "invitation") return <InvitationScreen invitation={view.invitation} state={state}
    onBack={() => dispatch({ type: "patch", patch: { view: { kind: "home" } } })} onAccept={accept} />;

  if (view.kind === "chat") {
    return <SharedChatScreen state={state} markdownTheme={markdownTheme}
      onBack={() => {
        chatLoadGeneration.current += 1;
        eventScopeRef.current = null;
        chatRef.current = null;
        messagesRef.current = [];
        dispatch({ type: "patch", patch: { view: { kind: "home" }, loadingMoreMessages: false } });
        void loadHome();
      }}
      onLoadMore={loadMoreMessages} onDraftChange={updateDraft} onSend={send} />;
  }

  return <CollaborationHomeScreen state={state} onReview={review} onOpen={loadChat} onLoadMore={loadMoreItems} />;
}

function InvitationScreen({ invitation, state, onBack, onAccept }: {
  invitation: Invitation;
  state: ScreenState;
  onBack: () => void;
  onAccept: (invitation: Invitation) => Promise<void>;
}) {
  return <ScrollView contentContainerStyle={styles.page}>
    <Back onPress={onBack} />
    <Text style={styles.title}>Join this shared Chat?</Text>
    <Text style={styles.body}>{invitation.owner.displayName} invited you as an {invitation.role}.</Text>
    <View style={styles.card}><Text style={styles.cardTitle}>This share includes</Text><Text style={styles.body}>The ongoing Chat history and human discussion.</Text>
      <Text style={styles.cardTitle}>This stays private</Text><Text style={styles.body}>Its project, sibling Chats, files, apps, terminals, and private drafts.</Text></View>
    <Text style={styles.muted}>AI requests are unavailable in shared Chats during this milestone.</Text>
    {state.error ? <Text accessibilityRole="alert" style={styles.error}>{state.error}</Text> : null}
    <Action label={state.loading ? "Accepting…" : "Accept invitation"} disabled={state.loading} onPress={() => void onAccept(invitation)} />
  </ScrollView>;
}

function SharedChatScreen({ state, markdownTheme, onBack, onLoadMore, onDraftChange, onSend }: {
  state: ScreenState;
  markdownTheme: ChatMarkdownTheme;
  onBack: () => void;
  onLoadMore: () => Promise<void>;
  onDraftChange: (text: string) => void;
  onSend: () => Promise<void>;
}) {
  const canDiscuss = state.scope?.capabilities.discuss === true;
  const renderMessage = useCallback(({ item }: ListRenderItemInfo<Message>) => (
    <ChatMessageCard message={item} markdownTheme={markdownTheme} />
  ), [markdownTheme]);
  return <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <SharedChatHeader state={state} onBack={onBack} />
    {state.loading ? <ActivityIndicator accessibilityLabel="Loading shared Chat" /> : null}
    <FlatList data={state.messages} keyExtractor={(message) => message.id} contentContainerStyle={styles.history}
      renderItem={renderMessage}
      ListEmptyComponent={!state.loading ? <Text style={styles.muted}>Start the discussion. Messages are visible to everyone in this Chat.</Text> : null}
      ListFooterComponent={state.hasMoreMessages ? <Action label={state.loadingMoreMessages ? "Loading…" : "Load more messages"}
        disabled={state.loadingMoreMessages} onPress={() => void onLoadMore()} /> : null} />
    <SharedChatComposer state={state} canDiscuss={canDiscuss} onDraftChange={onDraftChange} onSend={onSend} />
  </KeyboardAvoidingView>;
}

function SharedChatHeader({ state, onBack }: { state: ScreenState; onBack: () => void }) {
  return <View style={styles.header}><Back onPress={onBack} />
    <Text style={styles.title}>{state.chat?.title ?? "Shared Chat"}</Text>
    <Text style={styles.muted}>{state.scope ? `${roleLabel(state.scope.role)} · Discussion only` : "Loading…"}</Text>
  </View>;
}

function SharedChatComposer({ state, canDiscuss, onDraftChange, onSend }: {
  state: ScreenState;
  canDiscuss: boolean;
  onDraftChange: (text: string) => void;
  onSend: () => Promise<void>;
}) {
  const status = state.scope?.role === "viewer"
    ? "Viewers can read this Chat but cannot post messages."
    : canDiscuss ? "Messages are shared with everyone in this Chat." : "This Chat is read-only right now.";
  return <View style={styles.composer}>
    <Text style={styles.muted}>{status}</Text>
    <Text style={styles.muted}>AI requests are unavailable in shared Chats during this milestone.</Text>
    {state.error ? <Text accessibilityRole="alert" style={styles.error}>{state.error}</Text> : null}
    <TextInput accessibilityLabel="Message everyone" multiline value={state.draft} editable={canDiscuss && !state.sending}
      onChangeText={onDraftChange} placeholder={canDiscuss ? "Message everyone…" : "Read-only access"} style={styles.input} />
    <Action label={state.sending ? "Sending…" : "Send message"} disabled={Boolean(!canDiscuss || state.sending || !state.draft.trim())}
      onPress={() => void onSend()} />
  </View>;
}

function ChatMessageCard({ message, markdownTheme }: { message: Message; markdownTheme: ChatMarkdownTheme }) {
  return <View style={styles.message}>
    <Text style={styles.cardTitle}>{message.actor.displayName}</Text>
    {keyedMessageParts(message).map(({ key, part }) => <View key={key}>
      {part.type === "text" || part.type === "summary" ? renderChatMarkdown(part.text, markdownTheme) : null}
      {part.type === "attachment_reference" ? <Text style={styles.muted}>Attachment: {part.label}</Text> : null}
    </View>)}
  </View>;
}

function CollaborationHomeScreen({ state, onReview, onOpen, onLoadMore }: {
  state: ScreenState;
  onReview: (invitationId: string) => Promise<void>;
  onOpen: (scopeId: string) => Promise<void>;
  onLoadMore: () => Promise<void>;
}) {
  const renderDiscovery = useCallback(({ item }: ListRenderItemInfo<DiscoveryItem>) => (
    <DiscoveryCard item={item} onReview={onReview} onOpen={onOpen} />
  ), [onOpen, onReview]);
  return <FlatList data={state.items} keyExtractor={discoveryKey} contentContainerStyle={styles.page}
    ListHeaderComponent={<>
      <Text style={styles.title}>Shared with me</Text>
      <Text style={styles.muted}>Invitations and ongoing Chats shared with your Matrix account.</Text>
      {state.loading ? <ActivityIndicator accessibilityLabel="Loading shared Chats" /> : null}
      {state.error ? <Text accessibilityRole="alert" style={styles.error}>{state.error}</Text> : null}
      {!state.loading && !state.error && state.items.length === 0 ? <View style={styles.empty}>
        <Text style={styles.cardTitle}>Nothing shared yet</Text><Text style={styles.muted}>Invitations and accepted Chats will appear here.</Text>
      </View> : null}
    </>}
    renderItem={renderDiscovery}
    ListFooterComponent={<>
      {state.paginationError ? <Text accessibilityRole="alert" style={styles.error}>{state.paginationError}</Text> : null}
      {state.inboxCursor || state.sharedCursor ? <Action label={state.loadingMoreItems ? "Loading…" : "Load more shared items"}
        disabled={state.loadingMoreItems} onPress={() => void onLoadMore()} /> : null}
    </>} />;
}

function DiscoveryCard({ item, onReview, onOpen }: {
  item: DiscoveryItem;
  onReview: (invitationId: string) => Promise<void>;
  onOpen: (scopeId: string) => Promise<void>;
}) {
  if (item.status === "invited") return <View style={styles.card}>
    <Text style={styles.cardTitle}>{item.resource.owner.displayName} invited you</Text>
    <Text style={styles.muted}>Shared Chat · {roleLabel(item.resource.role)}</Text>
    <Action label={`Review invitation from ${item.resource.owner.displayName}`} onPress={() => void onReview(item.invitationId)} />
  </View>;
  return <View style={styles.card}>
    <Text style={styles.cardTitle}>{item.resource.chat.title}</Text>
    <Text style={styles.muted}>Shared Chat · {roleLabel(item.resource.scope.role)}</Text>
    <Action label={`Open ${item.resource.chat.title}`} onPress={() => void onOpen(item.scopeId)} />
  </View>;
}

function keyedMessageParts(message: Message) {
  const occurrences: Record<string, number> = {};
  return message.parts.map((part) => {
    const valueKey = JSON.stringify(part);
    const occurrence = occurrences[valueKey] ?? 0;
    occurrences[valueKey] = occurrence + 1;
    return { key: `${message.id}:${valueKey}:${occurrence}`, part };
  });
}

type RetryTimer = { cancel: () => void };

class CollaborationRecoverySupersededError extends Error {
  constructor() {
    super("Collaboration recovery was superseded");
    this.name = "CollaborationRecoverySupersededError";
  }
}

function createRetryTimer(callback: () => void, delay: number): RetryTimer {
  const timer = setTimeout(callback, delay);
  return { cancel: () => clearTimeout(timer) };
}

function discoveryKey(item: DiscoveryItem): string {
  return item.status === "invited" ? `invite:${item.invitationId}` : `scope:${item.scopeId}`;
}

function Action({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.action, (pressed || disabled) && styles.faded]}><Text style={styles.actionText}>{label}</Text></Pressable>;
}

function Back({ onPress }: { onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel="Back to Shared with me" onPress={onPress}><Text style={styles.back}>‹ Shared with me</Text></Pressable>;
}

function roleLabel(role: "owner" | "editor" | "viewer"): string { return role[0]!.toUpperCase() + role.slice(1); }

function randomUuid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.v2.appColors.canvas },
  page: { flexGrow: 1, gap: 16, padding: 20, backgroundColor: theme.v2.appColors.canvas },
  header: { gap: 6, paddingHorizontal: 20, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme.v2.colors.borderSubtle },
  title: { fontFamily: theme.v2.fonts.display, fontSize: 26, color: theme.v2.appColors.ink },
  body: { fontFamily: theme.v2.fonts.body, fontSize: 15, lineHeight: 22, color: theme.v2.appColors.ink },
  muted: { fontFamily: theme.v2.fonts.body, fontSize: 13, lineHeight: 19, color: theme.v2.appColors.muted },
  error: { fontFamily: theme.v2.fonts.semibold, fontSize: 13, color: theme.v2.colors.textDefault },
  card: { gap: 10, padding: 16, borderWidth: 1, borderColor: theme.v2.colors.borderSubtle, borderRadius: 16, backgroundColor: theme.v2.appColors.surface },
  cardTitle: { fontFamily: theme.v2.fonts.semibold, fontSize: 15, color: theme.v2.appColors.ink },
  empty: { alignItems: "center", gap: 6, padding: 32, borderWidth: 1, borderColor: theme.v2.colors.borderSubtle, borderRadius: 16 },
  history: { flexGrow: 1, gap: 12, padding: 16 },
  message: { gap: 8, padding: 14, borderWidth: 1, borderColor: theme.v2.colors.borderSubtle, borderRadius: 16, backgroundColor: theme.v2.appColors.surface },
  composer: { gap: 8, padding: 16, borderTopWidth: 1, borderTopColor: theme.v2.colors.borderSubtle, backgroundColor: theme.v2.appColors.canvas },
  input: { minHeight: 72, borderWidth: 1, borderColor: theme.v2.colors.borderSubtle, borderRadius: 14, padding: 12, color: theme.v2.appColors.ink, fontFamily: theme.v2.fonts.body, textAlignVertical: "top" },
  action: { alignItems: "center", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11, backgroundColor: theme.v2.palette.green[800] },
  actionText: { fontFamily: theme.v2.fonts.semibold, color: theme.v2.colors.textInverse },
  faded: { opacity: 0.55 },
  back: { fontFamily: theme.v2.fonts.semibold, color: theme.v2.colors.action },
}));
