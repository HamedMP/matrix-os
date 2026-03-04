import { useEffect, useState, useRef, useCallback } from "react";
import {
  View,
  Text,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  type ListRenderItemInfo,
} from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import { useAuth } from "@clerk/clerk-expo";
import { Ionicons } from "@expo/vector-icons";
import { useGateway } from "../_layout";
import { ChatMessage } from "@/components/ChatMessage";
import { InputBar } from "@/components/InputBar";
import { ConnectionBanner } from "@/components/ConnectionBanner";
import { colors, fonts, spacing } from "@/lib/theme";
import type { ServerMessage } from "@/lib/gateway-client";
import {
  getCachedMessages,
  setCachedMessages,
  getOutboundQueue,
  addToOutboundQueue,
  clearOutboundQueue,
  getRetryDelay,
  canRetry,
  type QueuedMessage,
} from "@/lib/offline";

export interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool?: string;
  timestamp: number;
}

let messageCounter = 0;
function nextId(): string {
  return `msg-${Date.now()}-${++messageCounter}`;
}

export default function ChatScreen() {
  const { client, connectionState, gateway, clearUnread, incrementUnread } = useGateway();
  const { isSignedIn } = useAuth();
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState<string>();
  const [queueCount, setQueueCount] = useState(0);
  const flatListRef = useRef<FlatList<Message>>(null);
  const prevConnectionState = useRef(connectionState);
  const isFocusedRef = useRef(true);

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
      router.replace("/connect");
    }
  }, [gateway, isSignedIn, router]);

  // Load cached messages on mount
  useEffect(() => {
    getCachedMessages().then((cached) => {
      if (cached.length > 0) {
        setMessages(cached);
      }
    });
    getOutboundQueue().then((q) => setQueueCount(q.length));
  }, []);

  // Save messages to cache when they change
  useEffect(() => {
    if (messages.length > 0) {
      setCachedMessages(messages);
    }
  }, [messages]);

  // Flush outbound queue on reconnect
  useEffect(() => {
    if (
      connectionState === "connected" &&
      prevConnectionState.current !== "connected" &&
      client
    ) {
      flushQueue();
    }
    prevConnectionState.current = connectionState;
  }, [connectionState, client]);

  async function flushQueue() {
    if (!client) return;
    const queue = await getOutboundQueue();
    if (queue.length === 0) return;

    const failed: QueuedMessage[] = [];
    for (const msg of queue) {
      const sent = client.sendMessage(msg.text, msg.sessionId);
      if (!sent) {
        if (canRetry(msg)) {
          failed.push({ ...msg, retries: msg.retries + 1 });
        }
      }
    }

    await clearOutboundQueue();
    for (const msg of failed) {
      await addToOutboundQueue(msg);
    }
    setQueueCount(failed.length);
  }

  useEffect(() => {
    if (!client) return;

    const unsub = client.onMessage((msg: ServerMessage) => {
      switch (msg.type) {
        case "kernel:init":
          setSessionId(msg.sessionId);
          setBusy(true);
          break;
        case "kernel:text":
          setMessages((prev) => {
            const last = prev[0];
            if (last?.role === "assistant" && !last.tool) {
              return [{ ...last, content: last.content + msg.text }, ...prev.slice(1)];
            }
            if (!isFocusedRef.current) {
              incrementUnread();
            }
            return [
              { id: nextId(), role: "assistant", content: msg.text, timestamp: Date.now() },
              ...prev,
            ];
          });
          break;
        case "kernel:tool_start":
          setMessages((prev) => [
            {
              id: nextId(),
              role: "tool",
              content: `Using ${msg.tool}`,
              tool: msg.tool,
              timestamp: Date.now(),
            },
            ...prev,
          ]);
          break;
        case "kernel:tool_end":
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.role === "tool" && m.content.startsWith("Using "));
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
          setMessages((prev) => [
            {
              id: nextId(),
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
  }, [client]);

  const handleSend = useCallback(
    async (text: string) => {
      if (!client || !text.trim()) return;
      const trimmed = text.trim();
      const userMsg: Message = {
        id: nextId(),
        role: "user",
        content: trimmed,
        timestamp: Date.now(),
      };
      setMessages((prev) => [userMsg, ...prev]);

      const sent = client.sendMessage(trimmed, sessionId);
      if (sent) {
        setBusy(true);
      } else {
        const queued: QueuedMessage = {
          id: userMsg.id,
          text: trimmed,
          sessionId,
          retries: 0,
          createdAt: Date.now(),
        };
        await addToOutboundQueue(queued);
        setQueueCount((c) => c + 1);
      }
    },
    [client, sessionId],
  );

  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const handleLoadOlder = useCallback(async () => {
    if (!client || loadingOlder || !hasMore || messages.length === 0) return;
    setLoadingOlder(true);
    try {
      const oldest = messages[messages.length - 1];
      const older = (await client.getMessages(sessionId, oldest.timestamp)) as Message[];
      if (older.length === 0) {
        setHasMore(false);
      } else {
        setMessages((prev) => [...prev, ...older]);
      }
    } catch {
      // silently handle
    } finally {
      setLoadingOlder(false);
    }
  }, [client, loadingOlder, hasMore, messages, sessionId]);

  const gatewayHttpUrl = client?.httpUrl;

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Message>) => (
      <ChatMessage message={item} gatewayUrl={gatewayHttpUrl} />
    ),
    [gatewayHttpUrl],
  );

  const keyExtractor = useCallback((item: Message) => item.id, []);

  const isConnected = connectionState === "connected";

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      <ConnectionBanner
        state={connectionState}
        queueCount={queueCount}
        onRetry={() => client?.connect()}
      />
      <FlatList
        ref={flatListRef}
        data={messages}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        inverted
        contentContainerStyle={styles.listContent}
        onEndReached={handleLoadOlder}
        onEndReachedThreshold={0.3}
        ListFooterComponent={
          loadingOlder ? (
            <View style={styles.loadingOlder}>
              <Text style={styles.loadingOlderText}>Loading older messages...</Text>
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <View style={styles.emptyIcon}>
              <Ionicons
                name={isConnected ? "chatbubble-outline" : "cloud-offline-outline"}
                size={40}
                color={isConnected ? colors.light.primary : colors.light.mutedForeground}
              />
            </View>
            <Text style={styles.emptyLabel}>Matrix OS</Text>
            <Text style={styles.emptySubtitle}>
              {isConnected
                ? "Send a message to start a conversation"
                : gateway
                  ? "Connecting to gateway..."
                  : "No gateway connected"}
            </Text>
            {isConnected && (
              <View style={styles.suggestionsContainer}>
                <Text style={styles.suggestionsTitle}>Try asking</Text>
                <View style={styles.suggestion}>
                  <Text style={styles.suggestionText}>"What can you help me with?"</Text>
                </View>
                <View style={styles.suggestion}>
                  <Text style={styles.suggestionText}>"Create a new task"</Text>
                </View>
                <View style={styles.suggestion}>
                  <Text style={styles.suggestionText}>"Show me my schedule"</Text>
                </View>
              </View>
            )}
          </View>
        }
      />
      <InputBar
        onSend={handleSend}
        busy={busy}
        connected={isConnected}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.light.background,
  },
  listContent: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: 8,
  },
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 60,
    paddingHorizontal: spacing.xl,
  },
  emptyIcon: {
    width: 80,
    height: 80,
    borderRadius: 20,
    backgroundColor: colors.light.card,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: colors.light.border,
  },
  emptyLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.light.primary,
    letterSpacing: 2,
    textTransform: "uppercase",
    marginBottom: spacing.sm,
  },
  emptySubtitle: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.light.mutedForeground,
    textAlign: "center",
  },
  suggestionsContainer: {
    marginTop: spacing["2xl"],
    width: "100%",
    gap: spacing.sm,
  },
  suggestionsTitle: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 12,
    color: colors.light.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
  },
  suggestion: {
    backgroundColor: colors.light.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.light.border,
    paddingVertical: 12,
    paddingHorizontal: spacing.lg,
  },
  suggestionText: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.light.foreground,
  },
  loadingOlder: {
    alignItems: "center",
    paddingVertical: spacing.md,
  },
  loadingOlderText: {
    fontFamily: fonts.sansMedium,
    fontSize: 12,
    color: colors.light.mutedForeground,
  },
});
