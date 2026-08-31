import { useState } from "react";
import { useUser } from "@clerk/clerk-expo";
import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import ArrowUp01Icon from "@hugeicons/core-free-icons/ArrowUp01Icon";
import { Image } from "expo-image";
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon, IconButton } from "@/components/ui";
import { mockColors, mockFonts } from "@/components/mock-shell/theme";

const rabbitArtwork = require("../../assets/app.icon/Assets/rabbit.svg");

export default function MockHomeScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useUser();
  const [message, setMessage] = useState("");
  const [sentMessage, setSentMessage] = useState<string | null>(null);
  const firstName = user?.firstName
    ?? user?.fullName?.trim().split(/\s+/)[0]
    ?? user?.username
    ?? "there";

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
                <Image
                  source={rabbitArtwork}
                  style={styles.responseRabbit}
                  contentFit="contain"
                  accessibilityLabel="Matrix OS"
                />
              </View>
              <Text style={styles.matrixText}>This is a mock response from your Matrix computer.</Text>
            </View>
          </View>
        ) : (
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
