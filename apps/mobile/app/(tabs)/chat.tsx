import { useEffect, useState, useRef, useCallback } from "react";
import {
  View,
  Text,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  type ListRenderItemInfo,
} from "react-native";
import { useRouter } from "expo-router";
import { useGateway } from "../_layout";
import { ChatMessage } from "@/components/ChatMessage";
import { InputBar } from "@/components/InputBar";
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

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-background"
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      <FlatList
        ref={flatListRef}
        data={messages}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        inverted
        contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 8, gap: 8 }}
        ListEmptyComponent={
          <View className="flex-1 items-center justify-center py-20">
            <Text className="font-mono text-xs uppercase tracking-widest text-primary">
              Matrix OS
            </Text>
            <Text className="mt-2 text-sm text-muted-foreground">
              {connectionState === "connected"
                ? "Send a message to start"
                : "Connecting to gateway..."}
            </Text>
          </View>
        }
      />
      <InputBar
        onSend={handleSend}
        busy={busy}
        connected={connectionState === "connected"}
      />
    </KeyboardAvoidingView>
  );
}
