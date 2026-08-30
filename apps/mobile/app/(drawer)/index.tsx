import { useState } from "react";
import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import ArrowUp01Icon from "@hugeicons/core-free-icons/ArrowUp01Icon";
import SparklesIcon from "@hugeicons/core-free-icons/SparklesIcon";
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon, IconButton } from "@/components/ui";
import { mockColors, mockFonts } from "@/components/mock-shell/theme";

export default function MockHomeScreen() {
  const insets = useSafeAreaInsets();
  const [message, setMessage] = useState("");
  const [sentMessage, setSentMessage] = useState<string | null>(null);

  function send() {
    const next = message.trim();
    if (!next) return;
    setSentMessage(next);
    setMessage("");
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={84}
    >
      <View style={styles.hero}>
        {sentMessage ? (
          <View style={styles.conversation}>
            <View style={styles.userBubble}>
              <Text style={styles.userText}>{sentMessage}</Text>
            </View>
            <View style={styles.matrixBubble}>
              <View style={styles.spark}>
                <Icon icon={SparklesIcon} size={16} color={mockColors.blue} />
              </View>
              <Text style={styles.matrixText}>This is a mock response from your Matrix computer.</Text>
            </View>
          </View>
        ) : (
          <View style={styles.emptyState}>
            <View style={styles.orb}>
              <Icon icon={SparklesIcon} size={26} color={mockColors.blue} />
            </View>
            <Text style={styles.title}>What should we do?</Text>
            <Text style={styles.subtitle}>Ask Matrix, open the drawer, or continue something recent.</Text>
          </View>
        )}
      </View>

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
            value={message}
            onChangeText={setMessage}
            onSubmitEditing={send}
            placeholder="Message Matrix"
            placeholderTextColor={mockColors.muted}
            returnKeyType="send"
            style={styles.input}
          />
          <IconButton
            accessibilityLabel="Send message"
            icon={ArrowUp01Icon}
            iconSize={19}
            iconColor={mockColors.surface}
            backgroundColor={message.trim() ? mockColors.blue : "#B7BAB7"}
            onPress={send}
          />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: mockColors.canvas,
  },
  hero: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  emptyState: {
    alignItems: "center",
    paddingBottom: 42,
  },
  orb: {
    width: 58,
    height: 58,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#B9D9FF",
    backgroundColor: mockColors.blueSoft,
    marginBottom: 20,
  },
  title: {
    fontFamily: mockFonts.display,
    fontSize: 28,
    letterSpacing: -0.7,
    color: mockColors.ink,
  },
  subtitle: {
    maxWidth: 290,
    marginTop: 8,
    fontFamily: mockFonts.body,
    fontSize: 14,
    lineHeight: 21,
    textAlign: "center",
    color: mockColors.muted,
  },
  conversation: {
    gap: 18,
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
  matrixText: {
    flex: 1,
    paddingTop: 4,
    fontFamily: mockFonts.body,
    fontSize: 15,
    lineHeight: 22,
    color: mockColors.ink,
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
