import { useState, useCallback } from "react";
import {
  View,
  TextInput,
  Pressable,
  ActivityIndicator,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { BlurView } from "expo-blur";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";

interface InputBarProps {
  onSend: (text: string) => void;
  busy: boolean;
  connected: boolean;
}

export function InputBar({ onSend, busy, connected }: InputBarProps) {
  const { theme } = useUnistyles();
  const [text, setText] = useState("");

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || !connected) return;
    if (process.env.EXPO_OS === "ios") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    onSend(trimmed);
    setText("");
  }, [text, connected, onSend]);

  const canSend = text.trim().length > 0 && connected && !busy;

  return (
    <BlurView tint="systemChromeMaterial" intensity={80} style={styles.container}>
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder={
            connected
              ? busy
                ? "Thinking..."
                : "Ask Matrix OS..."
              : "Connecting..."
          }
          placeholderTextColor={theme.colors.mutedForeground}
          multiline
          editable={connected && !busy}
          onSubmitEditing={handleSend}
          blurOnSubmit={false}
          returnKeyType="default"
        />
        <Pressable
          onPress={handleSend}
          disabled={!canSend}
          style={({ pressed }) => [
            styles.sendButton,
            canSend ? styles.sendButtonActive : styles.sendButtonDisabled,
            pressed && canSend && styles.sendButtonPressed,
          ]}
        >
          {busy ? (
            <ActivityIndicator size="small" color={theme.colors.primaryForeground} />
          ) : (
            <Ionicons
              name="arrow-up"
              size={18}
              color={canSend ? theme.colors.primaryForeground : theme.colors.mutedForeground}
            />
          )}
        </Pressable>
      </View>
    </BlurView>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    overflow: "hidden" as const,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
    paddingBottom: process.env.EXPO_OS === "ios" ? theme.spacing["2xl"] : theme.spacing.md,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing.sm,
    borderRadius: theme.radius.xl,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: "rgba(255, 255, 255, 0.6)",
    paddingHorizontal: theme.spacing.md,
    paddingVertical: process.env.EXPO_OS === "ios" ? 8 : 4,
  },
  input: {
    flex: 1,
    fontFamily: theme.fonts.sans,
    fontSize: 15,
    color: theme.colors.foreground,
    minHeight: 36,
    maxHeight: 100,
    paddingVertical: process.env.EXPO_OS === "ios" ? 8 : 6,
  },
  sendButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
  sendButtonActive: {
    backgroundColor: theme.colors.primary,
  },
  sendButtonDisabled: {
    backgroundColor: theme.colors.muted,
  },
  sendButtonPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.95 }],
  },
}));
