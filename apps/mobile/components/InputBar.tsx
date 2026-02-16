import { useState, useCallback } from "react";
import {
  View,
  TextInput,
  Pressable,
  Text,
  ActivityIndicator,
  StyleSheet,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, fonts, spacing, radius } from "@/lib/theme";

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
    <View style={styles.container}>
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
          placeholderTextColor={colors.light.mutedForeground}
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
            <ActivityIndicator size="small" color={colors.light.primaryForeground} />
          ) : (
            <Ionicons
              name="arrow-up"
              size={18}
              color={canSend ? colors.light.primaryForeground : colors.light.mutedForeground}
            />
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.light.border,
    backgroundColor: colors.light.card,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: Platform.OS === "ios" ? spacing["2xl"] : spacing.md,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.light.border,
    backgroundColor: colors.light.background,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === "ios" ? 8 : 4,
  },
  input: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 15,
    color: colors.light.foreground,
    minHeight: 36,
    maxHeight: 100,
    paddingVertical: Platform.OS === "ios" ? 8 : 6,
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
    backgroundColor: colors.light.primary,
  },
  sendButtonDisabled: {
    backgroundColor: colors.light.muted,
  },
  sendButtonPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.95 }],
  },
});
