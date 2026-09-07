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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { z } from "zod/v4";
import { renderChatMarkdown } from "@/lib/chat-markdown";
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

export default function SharedScreen() {
  const { getToken, userId } = useAuth();
  const getTokenRef = useRef(getToken);
  useEffect(() => { getTokenRef.current = getToken; }, [getToken]);
  const { theme } = useUnistyles();
  const [view, setView] = useState<ViewState>({ kind: "home" });
  const [items, setItems] = useState<DiscoveryItem[]>([]);
  const [scope, setScope] = useState<Scope | null>(null);
  const [chat, setChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingMoreMessages, setLoadingMoreMessages] = useState(false);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const chatLoadGeneration = useRef(0);
  const latestSequenceRef = useRef("0");
  const eventSequenceRef = useRef("0");
  const eventScopeRef = useRef<string | null>(null);
  const messagesRef = useRef<Message[]>([]);
  const token = useCallback(async () => {
    const value = await getTokenRef.current();
    if (!value) throw new Error("CollaborationUnavailable");
    return value;
  }, []);
  const loadHome = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const actorToken = await token();
      const [inbox, shared] = await Promise.all([
        fetchCollaborationInbox(actorToken), fetchSharedCollaborations(actorToken),
      ]);
      setItems([...inbox.items, ...shared.items]);
    } catch (failure: unknown) {
      console.warn("[mobile-collaboration] discovery failed", failure instanceof Error ? failure.name : "UnknownError");
      setError("Shared Chats are unavailable. Pull down or return later to try again.");
    } finally { setLoading(false); }
  }, [token]);
  useEffect(() => { void loadHome(); }, [loadHome]);
  const loadChat = useCallback(async (scopeId: string) => {
    const generation = ++chatLoadGeneration.current;
    if (eventScopeRef.current !== scopeId) {
      eventScopeRef.current = scopeId;
      eventSequenceRef.current = "0";
      latestSequenceRef.current = "0";
      messagesRef.current = [];
    }
    setLoading(true); setError(""); setView({ kind: "chat", scopeId });
    setScope(null); setChat(null); setMessages([]); setDraft(""); setLoadingMoreMessages(false);
    try {
      const actorToken = await token();
      const [nextScope, nextChat, history] = await Promise.all([
        fetchCollaborationScope(actorToken, scopeId),
        fetchSharedChat(actorToken, scopeId),
        fetchSharedChatMessages(actorToken, scopeId),
      ]);
      const nextDraft = await loadCollaborationDraft(AsyncStorage, { actorId: userId, scopeId, chatId: nextChat.id });
      if (generation !== chatLoadGeneration.current) return;
      setScope(nextScope); setChat(nextChat); setMessages(history.messages); setDraft(nextDraft);
      messagesRef.current = history.messages;
      latestSequenceRef.current = history.messages.at(-1)?.sequence ?? "0";
      setHasMoreMessages(BigInt(nextChat.messageCount) > BigInt(history.messages.length));
      const sequence = history.messages.at(-1)?.sequence;
      if (sequence) void updateSharedChatReadState(actorToken, scopeId, sequence).catch((failure: unknown) => {
        console.warn("[mobile-collaboration] read state failed", failure instanceof Error ? failure.name : "UnknownError");
      });
    } catch (failure: unknown) {
      console.warn("[mobile-collaboration] Chat load failed", failure instanceof Error ? failure.name : "UnknownError");
      if (generation === chatLoadGeneration.current) {
        setError("This shared Chat is unavailable. Your access may have changed.");
      }
    } finally {
      if (generation === chatLoadGeneration.current) setLoading(false);
    }
  }, [token, userId]);
  const loadMoreMessages = async () => {
    if (view.kind !== "chat" || !chat || loadingMoreMessages) return;
    const after = messages.at(-1)?.sequence;
    if (!after) return;
    const generation = chatLoadGeneration.current;
    setLoadingMoreMessages(true); setError("");
    try {
      const page = await fetchSharedChatMessages(await token(), view.scopeId, after);
      if (generation !== chatLoadGeneration.current) return;
      const appended = page.messages.filter((message) => !messages.some((known) => known.id === message.id));
      const combined = [...messages, ...appended];
      setMessages(combined);
      messagesRef.current = combined;
      latestSequenceRef.current = combined.at(-1)?.sequence ?? latestSequenceRef.current;
      setHasMoreMessages(appended.length > 0 && BigInt(chat.messageCount) > BigInt(combined.length));
    } catch (failure: unknown) {
      console.warn("[mobile-collaboration] history page failed", failure instanceof Error ? failure.name : "UnknownError");
      if (generation === chatLoadGeneration.current) setError("More messages could not be loaded. Try again.");
    } finally {
      if (generation === chatLoadGeneration.current) setLoadingMoreMessages(false);
    }
  };
  const refreshLiveChat = useCallback(async (scopeId: string) => {
    const actorToken = await token();
    const [nextScope, nextChat, page] = await Promise.all([
      fetchCollaborationScope(actorToken, scopeId),
      fetchSharedChat(actorToken, scopeId),
      fetchSharedChatMessages(actorToken, scopeId, latestSequenceRef.current),
    ]);
    setScope(nextScope);
    setChat(nextChat);
    const known = new Set(messagesRef.current.map((message) => message.id));
    const combined = [...messagesRef.current, ...page.messages.filter((message) => !known.has(message.id))];
    messagesRef.current = combined;
    setMessages(combined);
    latestSequenceRef.current = combined.at(-1)?.sequence ?? latestSequenceRef.current;
    setHasMoreMessages(BigInt(nextChat.messageCount) > BigInt(combined.length));
    const sequence = page.messages.at(-1)?.sequence;
    if (sequence) void updateSharedChatReadState(actorToken, scopeId, sequence).catch((failure: unknown) => {
      console.warn("[mobile-collaboration] realtime read state failed", failure instanceof Error ? failure.name : "UnknownError");
    });
  }, [token]);
  const activeScopeId = view.kind === "chat" ? view.scopeId : null;
  useEffect(() => {
    if (!activeScopeId) return;
    let closed = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
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
        next.onopen = () => { attempt = 0; };
        next.onmessage = (event) => {
          if (typeof event.data !== "string" || event.data.length > 64 * 1024) {
            next.close(1008, "Invalid frame");
            return;
          }
          try {
            const frame = CollaborationEventFrameSchema.parse(JSON.parse(event.data) as unknown);
            if (frame.scopeId !== activeScopeId) throw new Error("ScopeMismatch");
            if ("sequence" in frame) eventSequenceRef.current = frame.sequence;
            if (frame.type === "heartbeat") {
              if (next.readyState === WebSocket.OPEN) next.send(JSON.stringify({ version: 1, type: "heartbeat" }));
            } else if (frame.type === "unavailable") {
              closed = true;
              setScope(null);
              setError("This shared Chat is unavailable. Your access may have changed.");
              next.close(1008, "Unavailable");
            } else if (["changed", "capabilities_changed", "refresh_required"].includes(frame.type)) {
              void refreshLiveChat(activeScopeId).catch((failure: unknown) => {
                console.warn("[mobile-collaboration] realtime refresh failed", failure instanceof Error ? failure.name : "UnknownError");
                setError("This shared Chat could not be refreshed. Try again.");
              });
            }
          } catch (failure: unknown) {
            console.warn("[mobile-collaboration] event frame rejected", failure instanceof Error ? failure.name : "UnknownError");
            next.close(1008, "Invalid frame");
          }
        };
        next.onerror = () => next.close();
        next.onclose = () => {
          if (socket === next) socket = null;
          if (closed) return;
          const delay = Math.min(10_000, 500 * (2 ** Math.min(attempt, 5)));
          attempt += 1;
          retryTimer = setTimeout(() => { void connect(); }, delay);
        };
      } catch (failure: unknown) {
        console.warn("[mobile-collaboration] event connection failed", failure instanceof Error ? failure.name : "UnknownError");
        if (closed) return;
        const delay = Math.min(10_000, 500 * (2 ** Math.min(attempt, 5)));
        attempt += 1;
        retryTimer = setTimeout(() => { void connect(); }, delay);
      }
    };
    void connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close(1000, "Closed");
    };
  }, [activeScopeId, refreshLiveChat, token]);
  const review = async (invitationId: string) => {
    setLoading(true); setError("");
    try { setView({ kind: "invitation", invitation: await fetchCollaborationInvitation(await token(), invitationId) }); }
    catch (failure: unknown) {
      console.warn("[mobile-collaboration] invitation load failed", failure instanceof Error ? failure.name : "UnknownError");
      setError("This invitation is unavailable.");
    } finally { setLoading(false); }
  };
  const accept = async (invitation: Invitation) => {
    setLoading(true); setError("");
    try {
      const result = await acceptCollaborationInvitation(await token(), invitation.id, invitation.revision, randomUuid());
      await loadChat(result.scopeId);
    } catch (failure: unknown) {
      console.warn("[mobile-collaboration] invitation acceptance failed", failure instanceof Error ? failure.name : "UnknownError");
      setError("Invitation could not be accepted. Try again.");
      setLoading(false);
    }
  };
  const updateDraft = (text: string) => {
    setDraft(text);
    if (!chat || view.kind !== "chat") return;
    void saveCollaborationDraft(AsyncStorage, {
      actorId: userId, scopeId: view.scopeId, chatId: chat.id, text,
    }).catch((failure: unknown) => {
      console.warn("[mobile-collaboration] draft save failed", failure instanceof Error ? failure.name : "UnknownError");
    });
  };
  const send = async () => {
    if (!scope || !chat || view.kind !== "chat" || !draft.trim() || !scope.capabilities.discuss) return;
    setSending(true); setError("");
    try {
      await postSharedChatDiscussion(await token(), view.scopeId, scope.revision, draft.trim(), randomUuid());
      await saveCollaborationDraft(AsyncStorage, { actorId: userId, scopeId: view.scopeId, chatId: chat.id, text: "" });
      setDraft("");
      await loadChat(view.scopeId);
    } catch (failure: unknown) {
      console.warn("[mobile-collaboration] discussion send failed", failure instanceof Error ? failure.name : "UnknownError");
      setError("Message was not sent. Your draft is still here—try again.");
    } finally { setSending(false); }
  };
  const markdownTheme = useMemo(() => ({
    textStyle: { color: theme.v2.appColors.ink, fontFamily: theme.v2.fonts.body, fontSize: 15, lineHeight: 22 },
    mutedColor: theme.v2.appColors.muted, linkColor: theme.v2.colors.action,
    codeBackground: theme.v2.appColors.soft, codeBorderColor: theme.v2.colors.borderSubtle,
    monoFontFamily: theme.v2.fonts.mono, boldFontFamily: theme.v2.fonts.semibold, headingFontFamily: theme.v2.fonts.display,
  }), [theme]);

  if (view.kind === "invitation") return <ScrollView contentContainerStyle={styles.page}>
    <Back onPress={() => setView({ kind: "home" })} />
    <Text style={styles.title}>Join this shared Chat?</Text>
    <Text style={styles.body}>{view.invitation.owner.displayName} invited you as an {view.invitation.role}.</Text>
    <View style={styles.card}><Text style={styles.cardTitle}>This share includes</Text><Text style={styles.body}>The ongoing Chat history and human discussion.</Text>
      <Text style={styles.cardTitle}>This stays private</Text><Text style={styles.body}>Its project, sibling Chats, files, apps, terminals, and private drafts.</Text></View>
    <Text style={styles.muted}>AI requests are unavailable in shared Chats during this milestone.</Text>
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    <Action label={loading ? "Accepting…" : "Accept invitation"} disabled={loading} onPress={() => void accept(view.invitation)} />
  </ScrollView>;

  if (view.kind === "chat") {
    const viewer = scope?.role === "viewer";
    const canDiscuss = scope?.capabilities.discuss === true;
    return <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.header}><Back onPress={() => {
        chatLoadGeneration.current += 1;
        setLoadingMoreMessages(false);
        setView({ kind: "home" });
        void loadHome();
      }} />
        <Text style={styles.title}>{chat?.title ?? "Shared Chat"}</Text><Text style={styles.muted}>{scope ? `${roleLabel(scope.role)} · Discussion only` : "Loading…"}</Text></View>
      {loading ? <ActivityIndicator accessibilityLabel="Loading shared Chat" /> : null}
      <ScrollView contentContainerStyle={styles.history}>
        {messages.length === 0 && !loading ? <Text style={styles.muted}>Start the discussion. Messages are visible to everyone in this Chat.</Text> : null}
        {messages.map((message) => <View key={message.id} style={styles.message}>
          <Text style={styles.cardTitle}>{message.actor.displayName}</Text>
          {message.parts.flatMap((part, index) => part.type === "text" || part.type === "summary"
            ? renderChatMarkdown(part.text, markdownTheme).map((node, nodeIndex) => <View key={`${index}:${nodeIndex}`}>{node}</View>)
            : part.type === "attachment_reference" ? [<Text key={index} style={styles.muted}>Attachment: {part.label}</Text>] : [])}
        </View>)}
        {hasMoreMessages ? <Action label={loadingMoreMessages ? "Loading…" : "Load more messages"}
          disabled={loadingMoreMessages} onPress={() => void loadMoreMessages()} /> : null}
      </ScrollView>
      <View style={styles.composer}><Text style={styles.muted}>{viewer ? "Viewers can read this Chat but cannot post messages." : canDiscuss ? "Messages are shared with everyone in this Chat." : "This Chat is read-only right now."}</Text>
        <Text style={styles.muted}>AI requests are unavailable in shared Chats during this milestone.</Text>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        <TextInput accessibilityLabel="Message everyone" multiline value={draft} editable={canDiscuss && !sending} onChangeText={updateDraft}
          placeholder={canDiscuss ? "Message everyone…" : "Read-only access"} style={styles.input} />
        <Action label={sending ? "Sending…" : "Send message"} disabled={Boolean(!canDiscuss || sending || !draft.trim())} onPress={() => void send()} />
      </View>
    </KeyboardAvoidingView>;
  }

  return <ScrollView contentContainerStyle={styles.page} refreshControl={undefined}>
    <Text style={styles.title}>Shared with me</Text><Text style={styles.muted}>Invitations and ongoing Chats shared with your Matrix account.</Text>
    {loading ? <ActivityIndicator accessibilityLabel="Loading shared Chats" /> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {!loading && !error && items.length === 0 ? <View style={styles.empty}><Text style={styles.cardTitle}>Nothing shared yet</Text><Text style={styles.muted}>Invitations and accepted Chats will appear here.</Text></View> : null}
    {items.map((item) => item.status === "invited" ? <View key={item.invitationId} style={styles.card}>
      <Text style={styles.cardTitle}>{item.resource.owner.displayName} invited you</Text><Text style={styles.muted}>Shared Chat · {roleLabel(item.resource.role)}</Text>
      <Action label={`Review invitation from ${item.resource.owner.displayName}`} onPress={() => void review(item.invitationId)} />
    </View> : <View key={item.scopeId} style={styles.card}>
      <Text style={styles.cardTitle}>{item.resource.chat.title}</Text><Text style={styles.muted}>Shared Chat · {roleLabel(item.resource.scope.role)}</Text>
      <Action label={`Open ${item.resource.chat.title}`} onPress={() => void loadChat(item.scopeId)} />
    </View>)}
  </ScrollView>;
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
