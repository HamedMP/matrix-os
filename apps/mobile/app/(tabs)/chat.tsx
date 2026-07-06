import "@/lib/hermes-polyfills";
import { useEffect, useState, useRef, useCallback, useEffectEvent } from "react";
import {
  View,
  Text,
  FlatList,
  KeyboardAvoidingView,
  Pressable,
  type ListRenderItemInfo,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useRouter, useFocusEffect } from "expo-router";
import { useAuth } from "@clerk/clerk-expo";
import { Ionicons } from "@expo/vector-icons";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  cancelAnimation,
} from "react-native-reanimated";
import { useGateway } from "../_layout";
import { ChatMessage } from "@/components/ChatMessage";
import { InputBar } from "@/components/InputBar";
import { ConnectionBanner } from "@/components/ConnectionBanner";
import type { ServerMessage } from "@/lib/gateway-client";
import {
  getCachedMessages,
  setCachedMessages,
  getOutboundQueue,
  addToOutboundQueue,
  clearOutboundQueue,
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

function TypingIndicator() {
  const opacity = useSharedValue(0.3);

  useEffect(() => {
    opacity.value = withRepeat(withTiming(1, { duration: 600 }), -1, true);
    return () => cancelAnimation(opacity);
  }, [opacity]);

  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View style={[typingStyles.container, style]}>
      <View style={typingStyles.dot} />
      <View style={typingStyles.dot} />
      <View style={typingStyles.dot} />
    </Animated.View>
  );
}

const typingStyles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
    backgroundColor: theme.colors.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 16,
    borderCurve: "continuous" as const,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: 10,
    marginHorizontal: theme.spacing.lg,
    marginTop: theme.spacing.sm,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.mutedForeground,
  },
}));

// react-doctor-disable-next-line react-doctor/no-giant-component -- mobile chat is an intentionally integrated screen; splitting it is deferred outside the React Doctor score cleanup stack.
export default function ChatScreen() {
  const { theme } = useUnistyles();
  const { client, connectionState, gateway, clearUnread, incrementUnread } = useGateway();
  const { isSignedIn } = useAuth();
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const [queueCount, setQueueCount] = useState(0);
  const flatListRef = useRef<FlatList<Message>>(null);
  const prevConnectionState = useRef(connectionState);
  const isFocusedRef = useRef(true);
  // Mirrors whether the head message is a streaming (non-tool) assistant message,
  // so we can decide synchronously whether an incoming kernel:text starts a NEW
  // assistant message — the setMessages updater runs deferred and can't drive that.
  const headIsStreamingAssistantRef = useRef(false);

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
        setMessages(cached);
      }
    });
    getOutboundQueue().then((q) => setQueueCount(q.length));
  }, []);

  // Save messages to cache (debounced to avoid writes during streaming)
  useEffect(() => {
    if (messages.length === 0) return;
    const timer = setTimeout(() => setCachedMessages(messages), 1000);
    return () => clearTimeout(timer);
  }, [messages]);

  // Flush outbound queue on reconnect
  useEffect(() => {
    if (
      connectionState === "connected" &&
      prevConnectionState.current !== "connected" &&
      client
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
          sessionIdRef.current = msg.sessionId;
          setBusy(true);
          break;
        case "kernel:text": {
          // Decide synchronously (the updater below runs deferred, so a flag set
          // inside it would still be false here).
          const startedNewMessage = !headIsStreamingAssistantRef.current;
          headIsStreamingAssistantRef.current = true;
          setMessages((prev) => {
            const last = prev[0];
            if (last?.role === "assistant" && !last.tool) {
              return [{ ...last, content: last.content + msg.text }, ...prev.slice(1)];
            }
            return [
              { id: nextId(), role: "assistant", content: msg.text, timestamp: Date.now() },
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
      // A user message becomes the new head, so the next assistant token starts
      // a fresh assistant message.
      headIsStreamingAssistantRef.current = false;
      setMessages((prev) => [userMsg, ...prev]);

      const sent = client.sendMessage(trimmed, sessionIdRef.current);
      if (sent) {
        setBusy(true);
      } else {
        const queued: QueuedMessage = {
          id: userMsg.id,
          text: trimmed,
          sessionId: sessionIdRef.current,
          retries: 0,
          createdAt: Date.now(),
        };
        await addToOutboundQueue(queued);
        setQueueCount((c) => c + 1);
      }
    },
    [client],
  );

  const [loadingOlder, setLoadingOlder] = useState(false);
  const hasMoreRef = useRef(true);

  const handleLoadOlder = useCallback(async () => {
    if (!client || loadingOlder || !hasMoreRef.current || messages.length === 0) return;
    setLoadingOlder(true);
    try {
      const oldest = messages[messages.length - 1];
      const older = (await client.getMessages(sessionIdRef.current, oldest.timestamp)) as Message[];
      if (older.length === 0) {
        hasMoreRef.current = false;
      } else {
        setMessages((prev) => [...prev, ...older]);
      }
    } catch {
      // silently handle
    } finally {
      setLoadingOlder(false);
    }
  }, [client, loadingOlder, messages]);

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
      behavior={process.env.EXPO_OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={process.env.EXPO_OS === "ios" ? 90 : 0}
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
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.listContent}
        onEndReached={handleLoadOlder}
        onEndReachedThreshold={0.3}
        ListHeaderComponent={busy ? <TypingIndicator /> : null}
        ListFooterComponent={
          loadingOlder ? (
            <View style={styles.loadingOlder}>
              <Text style={styles.loadingOlderText}>Loading older messages…</Text>
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <View style={styles.emptyIcon}>
              <Ionicons
                name={isConnected ? "chatbubble-outline" : "cloud-offline-outline"}
                size={40}
                color={isConnected ? theme.colors.primary : theme.colors.mutedForeground}
              />
            </View>
            <Text style={styles.emptyLabel}>Matrix OS</Text>
            <Text style={styles.emptySubtitle}>
              {isConnected
                ? "Send a message to start a conversation"
                  : gateway
                    ? "Connecting to Matrix OS..."
                    : "Sign in to connect"}
            </Text>
            {isConnected && (
              <View style={styles.suggestionsContainer}>
                <Text style={styles.suggestionsTitle}>Try asking</Text>
                <Pressable
                  onPress={() => handleSend("What can you help me with?")}
                  style={({ pressed }) => [styles.suggestion, pressed && { opacity: 0.7 }]}
                >
                  <Text style={styles.suggestionText}>{"\"What can you help me with?\""}</Text>
                </Pressable>
                <Pressable
                  onPress={() => handleSend("Create a new task")}
                  style={({ pressed }) => [styles.suggestion, pressed && { opacity: 0.7 }]}
                >
                  <Text style={styles.suggestionText}>{"\"Create a new task\""}</Text>
                </Pressable>
                <Pressable
                  onPress={() => handleSend("Show me my schedule")}
                  style={({ pressed }) => [styles.suggestion, pressed && { opacity: 0.7 }]}
                >
                  <Text style={styles.suggestionText}>{"\"Show me my schedule\""}</Text>
                </Pressable>
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

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  listContent: {
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    gap: 8,
  },
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 60,
    paddingHorizontal: theme.spacing.xl,
  },
  emptyIcon: {
    width: 80,
    height: 80,
    borderRadius: 20,
    borderCurve: "continuous" as const,
    backgroundColor: theme.colors.card,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  emptyLabel: {
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    color: theme.colors.primary,
    letterSpacing: 2,
    textTransform: "uppercase",
    marginBottom: theme.spacing.sm,
  },
  emptySubtitle: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 14,
    color: theme.colors.mutedForeground,
    textAlign: "center",
  },
  suggestionsContainer: {
    marginTop: theme.spacing["2xl"],
    width: "100%",
    gap: theme.spacing.sm,
  },
  suggestionsTitle: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 12,
    color: theme.colors.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: theme.spacing.xs,
  },
  suggestion: {
    backgroundColor: theme.colors.card,
    borderRadius: 12,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingVertical: 12,
    paddingHorizontal: theme.spacing.lg,
  },
  suggestionText: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 14,
    color: theme.colors.foreground,
  },
  loadingOlder: {
    alignItems: "center",
    paddingVertical: theme.spacing.md,
  },
  loadingOlderText: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 12,
    color: theme.colors.mutedForeground,
  },
}));
