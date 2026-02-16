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
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useGateway } from "../_layout";
import { ChatMessage } from "@/components/ChatMessage";
import { InputBar } from "@/components/InputBar";
import { colors, fonts, spacing } from "@/lib/theme";
import type { ServerMessage } from "@/lib/gateway-client";

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
  const { client, connectionState, gateway } = useGateway();
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState<string>();
  const flatListRef = useRef<FlatList<Message>>(null);

  useEffect(() => {
    if (!gateway) {
      router.replace("/connect");
    }
  }, [gateway, router]);

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
    (text: string) => {
      if (!client || !text.trim()) return;
      const userMsg: Message = {
        id: nextId(),
        role: "user",
        content: text.trim(),
        timestamp: Date.now(),
      };
      setMessages((prev) => [userMsg, ...prev]);
      setBusy(true);
      client.sendMessage(text.trim(), sessionId);
    },
    [client, sessionId],
  );

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Message>) => <ChatMessage message={item} />,
    [],
  );

  const keyExtractor = useCallback((item: Message) => item.id, []);

  const isConnected = connectionState === "connected";

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      <FlatList
        ref={flatListRef}
        data={messages}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        inverted
        contentContainerStyle={styles.listContent}
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
                : "Connecting to gateway..."}
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
});
