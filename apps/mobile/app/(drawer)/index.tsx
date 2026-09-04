import "@/lib/hermes-polyfills";
import { useEffect, useState, useRef, useCallback, useEffectEvent } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ListRenderItemInfo,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter, useFocusEffect } from "expo-router";
import { useAuth, useUser } from "@clerk/clerk-expo";
import { Image } from "expo-image";
import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import ArrowUp01Icon from "@hugeicons/core-free-icons/ArrowUp01Icon";
import WifiOffIcon from "@hugeicons/core-free-icons/WifiOff01Icon";

import { useGateway } from "../_layout";
import { useChatSession } from "@/lib/chat-session-context";
import { useConversationMessages } from "@/lib/queries/use-conversation-messages";
import { Icon, IconButton } from "@/components/ui";
import { mockColors, mockFonts } from "@/components/mock-shell/theme";
import type { ServerMessage } from "@/lib/gateway-client";
import { nextMessageId, type Message } from "@/lib/chat-message";
import {
  getCachedMessages,
  setCachedMessages,
  getOutboundQueue,
  addToOutboundQueue,
  clearOutboundQueue,
  canRetry,
  type QueuedMessage,
} from "@/lib/offline";
import { AnalyticsMask, capture } from "@/lib/analytics";

const rabbitArtwork = require("../../assets/app.icon/Assets/rabbit.svg");

// react-doctor-disable-next-line react-doctor/no-giant-component -- mobile chat is an intentionally integrated screen; splitting it is deferred outside the React Doctor score cleanup stack.
export default function ChatScreen() {
  const { client, connectionState, gateway, clearUnread, incrementUnread } = useGateway();
  const { activeSessionId, syncActiveSessionId } = useChatSession();
  const { isSignedIn } = useAuth();
  const { user } = useUser();
  const router = useRouter();
  const firstName = user?.firstName
    ?? user?.fullName?.trim().split(/\s+/)[0]
    ?? user?.username
    ?? "there";

  const [liveMessages, setLiveMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [queueCount, setQueueCount] = useState(0);
  const flatListRef = useRef<FlatList<Message>>(null);
  const prevConnectionState = useRef(connectionState);
  const isFocusedRef = useRef(true);
  // Mirrors whether the head message is a streaming (non-tool) assistant message,
  // so we can decide synchronously whether an incoming kernel:text starts a NEW
  // assistant message — the setMessages updater runs deferred and can't drive that.
  const headIsStreamingAssistantRef = useRef(false);

  const {
    messages: historyMessages,
    hasOlder,
    isLoadingOlder,
    loadOlder,
  } = useConversationMessages(activeSessionId);

  useFocusEffect(
    useCallback(() => {
      isFocusedRef.current = true;
      clearUnread();
      return () => {
        isFocusedRef.current = false;
      };
    }, [clearUnread]),
  );

  useEffect(() => {
    if (!gateway && !isSignedIn) {
      router.replace("/sign-in");
    }
  }, [gateway, isSignedIn, router]);

  // Load cached messages on mount
  useEffect(() => {
    getCachedMessages().then((cached) => {
      if (cached.length > 0) {
        setLiveMessages(cached);
      }
    });
    getOutboundQueue().then((q) => setQueueCount(q.length));
  }, []);

  // Save live messages to cache (debounced to avoid writes during streaming)
  useEffect(() => {
    if (liveMessages.length === 0) return;
    const timer = setTimeout(() => setCachedMessages(liveMessages), 1000);
    return () => clearTimeout(timer);
  }, [liveMessages]);

  // Flush outbound queue on reconnect
  useEffect(() => {
    if (
      connectionState === "connected"
      && prevConnectionState.current !== "connected"
      && client
    ) {
      const c = client;
      (async () => {
        const queue = await getOutboundQueue();
        if (queue.length === 0) return;

        const failed: QueuedMessage[] = [];
        for (const msg of queue) {
          const sent = c.sendMessage(msg.text, msg.sessionId);
          if (!sent) {
            if (canRetry(msg)) {
              failed.push({ ...msg, retries: msg.retries + 1 });
            }
          }
        }

        await clearOutboundQueue();
        for (const msg of failed) {
          // react-doctor-disable-next-line react-doctor/async-await-in-loop -- addToOutboundQueue does read-modify-write on a single AsyncStorage key; concurrent writes would lose updates and scramble FIFO order
          await addToOutboundQueue(msg);
        }
        setQueueCount(failed.length);
      })();
    }
    prevConnectionState.current = connectionState;
  }, [connectionState, client]);

  const resetTranscript = useCallback(() => {
    headIsStreamingAssistantRef.current = false;
    setBusy(false);
    setLiveMessages([]);
    void setCachedMessages([]);
  }, []);

  // A conversation switch (drawer selection, new chat, or a kernel-driven
  // session sync) starts a fresh live transcript; the persisted tail comes
  // back through useConversationMessages keyed off activeSessionId.
  const prevSessionIdRef = useRef(activeSessionId);
  useEffect(() => {
    if (activeSessionId === prevSessionIdRef.current) return;
    prevSessionIdRef.current = activeSessionId;
    resetTranscript();
  }, [activeSessionId, resetTranscript]);

  const onMissedAssistantMessage = useEffectEvent(() => {
    if (!isFocusedRef.current) {
      incrementUnread();
    }
  });

  useEffect(() => {
    if (!client) return;

    const unsub = client.onMessage((msg: ServerMessage) => {
      switch (msg.type) {
        case "kernel:init":
          syncActiveSessionId(msg.sessionId);
          setBusy(true);
          break;
        case "session:switched":
          syncActiveSessionId(msg.sessionId);
          break;
        case "kernel:text": {
          // Decide synchronously (the updater below runs deferred, so a flag set
          // inside it would still be false here).
          const startedNewMessage = !headIsStreamingAssistantRef.current;
          headIsStreamingAssistantRef.current = true;
          setLiveMessages((prev) => {
            const last = prev[0];
            if (last?.role === "assistant" && !last.tool) {
              return [{ ...last, content: last.content + msg.text }, ...prev.slice(1)];
            }
            return [
              { id: nextMessageId(), role: "assistant", content: msg.text, timestamp: Date.now() },
              ...prev,
            ];
          });
          if (startedNewMessage) {
            onMissedAssistantMessage();
          }
          break;
        }
        case "kernel:tool_start":
          headIsStreamingAssistantRef.current = false;
          setLiveMessages((prev) => [
            {
              id: nextMessageId(),
              role: "tool",
              content: `Using ${msg.tool}`,
              tool: msg.tool,
              timestamp: Date.now(),
            },
            ...prev,
          ]);
          break;
        case "kernel:tool_end":
          setLiveMessages((prev) => {
            const idx = prev.findLastIndex((m) => m.role === "tool" && m.content.startsWith("Using "));
            if (idx >= 0) {
              const updated = { ...prev[idx], content: prev[idx].content.replace("Using ", "Used ") };
              return [...prev.slice(0, idx), updated, ...prev.slice(idx + 1)];
            }
            return prev;
          });
          break;
        case "kernel:result":
          setBusy(false);
          break;
        case "kernel:error":
          setBusy(false);
          headIsStreamingAssistantRef.current = false;
          setLiveMessages((prev) => [
            {
              id: nextMessageId(),
              role: "system",
              content: msg.message,
              timestamp: Date.now(),
            },
            ...prev,
          ]);
          break;
      }
    });

    return unsub;
  }, [client, syncActiveSessionId]);

  const [draft, setDraft] = useState("");

  const handleSend = useCallback(
    async (text: string) => {
      if (!client || !text.trim()) return;
      const trimmed = text.trim();
      const userMsg: Message = {
        id: nextMessageId(),
        role: "user",
        content: trimmed,
        timestamp: Date.now(),
      };
      // A user message becomes the new head, so the next assistant token starts
      // a fresh assistant message.
      headIsStreamingAssistantRef.current = false;
      setLiveMessages((prev) => [userMsg, ...prev]);

      // Sending with no sessionId (a fresh draft chat) lets the kernel create
      // the conversation lazily; kernel:init reports the new id.
      const sent = client.sendMessage(trimmed, activeSessionId ?? undefined);
      capture("chat_message_sent", { queued: !sent });
      if (sent) {
        setBusy(true);
      } else {
        const queued: QueuedMessage = {
          id: userMsg.id,
          text: trimmed,
          sessionId: activeSessionId ?? undefined,
          retries: 0,
          createdAt: Date.now(),
        };
        await addToOutboundQueue(queued);
        setQueueCount((c) => c + 1);
      }
    },
    [client, activeSessionId],
  );

  const send = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setDraft("");
    void handleSend(trimmed);
  }, [draft, handleSend]);

  const insets = useSafeAreaInsets();

  const handleLoadOlder = useCallback(() => {
    if (!hasOlder || isLoadingOlder) return;
    void loadOlder();
  }, [hasOlder, isLoadingOlder, loadOlder]);

  const messages = [...liveMessages, ...historyMessages];
  const isConnected = connectionState === "connected";
  const hasDraftText = draft.trim().length > 0;
  const canSend = hasDraftText && isConnected && !busy;

  const renderItem = useCallback(({ item }: ListRenderItemInfo<Message>) => (
    <AnalyticsMask>
      <MessageBubble message={item} />
    </AnalyticsMask>
  ), []);

  const keyExtractor = useCallback((item: Message) => item.id, []);

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={84}
    >
      {!isConnected ? (
        <View style={styles.statusBanner}>
          <Icon icon={WifiOffIcon} size={14} color={mockColors.muted} />
          <Text style={styles.statusText}>
            {connectionState === "connecting"
              ? "Connecting to Matrix OS…"
              : `Chat offline${queueCount > 0 ? ` · ${queueCount} queued` : ""}`}
          </Text>
        </View>
      ) : null}

      <FlatList
        ref={flatListRef}
        style={styles.hero}
        data={messages}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        inverted
        contentContainerStyle={styles.listContent}
        onEndReached={handleLoadOlder}
        onEndReachedThreshold={0.3}
        ListFooterComponent={
          isLoadingOlder ? (
            <Text style={styles.loadingOlderText}>Loading older messages…</Text>
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <View style={styles.orb} testID="home-rabbit-container">
              <Image
                source={rabbitArtwork}
                style={styles.rabbit}
                contentFit="contain"
                accessibilityLabel="Matrix OS"
                testID="home-rabbit-mark"
              />
            </View>
            <Text style={styles.title}>Welcome back {firstName}</Text>
          </View>
        }
      />

      <View style={[styles.composerWrap, { paddingBottom: Math.max(insets.bottom, 12) + 8 }]}>
        <View style={styles.composer}>
          <IconButton
            accessibilityLabel="Attach"
            icon={Add01Icon}
            iconSize={23}
            iconColor={mockColors.ink}
          />
          <TextInput
            accessibilityLabel="Message Matrix"
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={send}
            placeholder={isConnected ? "Message Matrix" : "Connecting…"}
            placeholderTextColor={mockColors.muted}
            editable={isConnected}
            returnKeyType="send"
            style={styles.input}
          />
          <IconButton
            accessibilityLabel={busy ? "Matrix is responding" : "Send message"}
            icon={ArrowUp01Icon}
            iconSize={19}
            iconColor={mockColors.surface}
            backgroundColor={canSend || busy ? mockColors.blue : "#B7BAB7"}
            loading={busy}
            disabled={!canSend}
            onPress={send}
          />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function MessageBubble({ message }: { message: Message }) {
  if (message.role === "user") {
    return (
      <View style={styles.userBubble}>
        <Text style={styles.userText}>{message.content}</Text>
      </View>
    );
  }
  if (message.role === "tool") {
    return (
      <View style={styles.toolRow}>
        <Text style={styles.toolText}>{message.content}</Text>
      </View>
    );
  }
  if (message.role === "system") {
    return (
      <View style={styles.systemRow}>
        <Text style={styles.systemText}>{message.content}</Text>
      </View>
    );
  }
  return (
    <View style={styles.matrixBubble}>
      <View style={styles.spark}>
        <Image
          source={rabbitArtwork}
          style={styles.responseRabbit}
          contentFit="contain"
          accessibilityLabel="Matrix OS"
        />
      </View>
      <Text style={styles.matrixText}>{message.content}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: mockColors.canvas,
  },
  statusBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 6,
  },
  statusText: {
    fontFamily: mockFonts.medium,
    fontSize: 12,
    color: mockColors.muted,
  },
  hero: {
    flex: 1,
  },
  listContent: {
    flexGrow: 1,
    justifyContent: "flex-end",
    paddingHorizontal: 24,
    paddingVertical: 18,
    gap: 18,
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingBottom: 42,
    // FlatList renders ListEmptyComponent right-side up even when inverted,
    // so undo the list's own flip here to keep the hero upright.
  },
  orb: {
    width: 68,
    height: 68,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },
  rabbit: {
    width: 68,
    height: 68,
  },
  title: {
    fontFamily: mockFonts.display,
    fontSize: 28,
    letterSpacing: -0.7,
    color: mockColors.ink,
  },
  userBubble: {
    maxWidth: "84%",
    alignSelf: "flex-end",
    borderRadius: 20,
    borderBottomRightRadius: 7,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: mockColors.ink,
  },
  userText: {
    fontFamily: mockFonts.body,
    fontSize: 15,
    lineHeight: 21,
    color: mockColors.surface,
  },
  matrixBubble: {
    maxWidth: "90%",
    alignSelf: "flex-start",
    flexDirection: "row",
    gap: 10,
  },
  spark: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    backgroundColor: mockColors.blueSoft,
  },
  responseRabbit: {
    width: 14,
    height: 19,
  },
  matrixText: {
    flex: 1,
    paddingTop: 4,
    fontFamily: mockFonts.body,
    fontSize: 15,
    lineHeight: 22,
    color: mockColors.ink,
  },
  toolRow: {
    alignSelf: "flex-start",
  },
  toolText: {
    fontFamily: mockFonts.medium,
    fontSize: 13,
    color: mockColors.muted,
  },
  systemRow: {
    alignSelf: "center",
  },
  systemText: {
    fontFamily: mockFonts.medium,
    fontSize: 13,
    color: mockColors.muted,
    textAlign: "center",
  },
  loadingOlderText: {
    alignSelf: "center",
    fontFamily: mockFonts.medium,
    fontSize: 12,
    color: mockColors.muted,
    paddingVertical: 8,
  },
  composerWrap: {
    paddingHorizontal: 14,
    paddingTop: 10,
  },
  composer: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: mockColors.line,
    borderRadius: 22,
    paddingHorizontal: 8,
    backgroundColor: mockColors.surface,
    boxShadow: "0 8px 24px rgba(23, 25, 24, 0.08)",
  },
  input: {
    flex: 1,
    minHeight: 46,
    fontFamily: mockFonts.body,
    fontSize: 15,
    color: mockColors.ink,
  },
});
