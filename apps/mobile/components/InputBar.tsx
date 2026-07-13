import { useState, useCallback } from "react";
import {
  View,
  TextInput,
  Pressable,
  ActivityIndicator,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
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
  const sendScale = useSharedValue(1);
  const sendAnimatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: sendScale.value }] }));

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || !connected) return;
    if (process.env.EXPO_OS === "ios") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    sendScale.value = 0.7;
    sendScale.value = withSpring(1, { damping: 12, stiffness: 320 });
    onSend(trimmed);
    setText("");
  }, [text, connected, onSend, sendScale]);

  const hasText = text.trim().length > 0;
  const canSend = hasText && connected && !busy;

  return (
    <BlurView tint="extraLight" intensity={40} style={styles.container}>
      <View style={styles.inputCard}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder={
            connected
              ? busy
                ? "Matrix is thinking…"
                : "Message your Matrix…"
              : "Connecting…"
          }
          placeholderTextColor={theme.colors.mutedForeground}
          multiline
          editable={connected && !busy}
          onSubmitEditing={handleSend}
          blurOnSubmit={false}
          returnKeyType="default"
        />
        <Animated.View style={sendAnimatedStyle}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={busy ? "Matrix is responding" : "Send message"}
            onPress={handleSend}
            disabled={!canSend}
            style={({ pressed }) => [
              styles.sendButton,
              canSend || busy ? styles.sendButtonActive : styles.sendButtonIdle,
              pressed && canSend && styles.sendButtonPressed,
            ]}
          >
            {busy ? (
              <ActivityIndicator size="small" color={theme.colors.primaryForeground} />
            ) : (
              <Ionicons
                name="arrow-up"
                size={17}
                color={canSend ? theme.colors.primaryForeground : theme.colors.mutedForeground}
              />
            )}
          </Pressable>
        </Animated.View>
      </View>
    </BlurView>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    overflow: "hidden" as const,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.xs,
    paddingBottom: process.env.EXPO_OS === "ios" ? theme.spacing.lg : theme.spacing.md,
  },
  // Floating pill: the input reads as a single object hovering over the canvas
  // rather than a full-width toolbar strip.
  inputCard: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing.sm,
    borderRadius: 26,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    paddingLeft: theme.spacing.lg,
    paddingRight: 6,
    paddingVertical: 6,
    boxShadow: "0 6px 24px rgba(50, 61, 46, 0.10), 0 1px 3px rgba(50, 61, 46, 0.06)",
  },
  input: {
    flex: 1,
    fontFamily: theme.fonts.sans,
    fontSize: 16,
    lineHeight: 21,
    color: theme.colors.foreground,
    minHeight: 38,
    maxHeight: 120,
    paddingVertical: process.env.EXPO_OS === "ios" ? 9 : 7,
  },
  sendButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  sendButtonActive: {
    backgroundColor: theme.colors.forest,
    boxShadow: "0 2px 8px rgba(50, 61, 46, 0.28)",
  },
  sendButtonIdle: {
    backgroundColor: theme.colors.secondary,
  },
  sendButtonPressed: {
    opacity: 0.9,
  },
}));
