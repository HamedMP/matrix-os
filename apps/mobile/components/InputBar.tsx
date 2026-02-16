import { useState, useCallback } from "react";
import {
  View,
  TextInput,
  Pressable,
  Text,
  ActivityIndicator,
} from "react-native";
import { BlurView } from "expo-blur";

interface InputBarProps {
  onSend: (text: string) => void;
  busy: boolean;
  connected: boolean;
}

export function InputBar({ onSend, busy, connected }: InputBarProps) {
  const [text, setText] = useState("");

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || !connected) return;
    onSend(trimmed);
    setText("");
  }, [text, connected, onSend]);

  const canSend = text.trim().length > 0 && connected && !busy;

  return (
    <View className="border-t border-border bg-card/90 px-4 pb-6 pt-2">
      <BlurView intensity={20} tint="light" className="overflow-hidden rounded-xl">
        <View className="flex-row items-end gap-2 rounded-xl border border-border bg-card/90 px-3 py-2">
          <TextInput
            className="min-h-[36px] max-h-[100px] flex-1 text-base text-foreground"
            style={{ fontFamily: "Inter_400Regular" }}
            value={text}
            onChangeText={setText}
            placeholder={
              connected
                ? busy
                  ? "Thinking..."
                  : "Ask Matrix OS..."
                : "Connecting..."
            }
            placeholderTextColor="#78716c"
            multiline
            editable={connected && !busy}
            onSubmitEditing={handleSend}
            blurOnSubmit={false}
            returnKeyType="default"
          />
          <Pressable
            onPress={handleSend}
            disabled={!canSend}
            className={`size-9 items-center justify-center rounded-lg ${
              canSend ? "bg-primary" : "bg-muted"
            }`}
          >
            {busy ? (
              <ActivityIndicator size="small" color="#ffffff" />
            ) : (
              <Text
                className={`text-sm font-bold ${
                  canSend ? "text-primary-foreground" : "text-muted-foreground"
                }`}
              >
                Send
              </Text>
            )}
          </Pressable>
        </View>
      </BlurView>
    </View>
  );
}
