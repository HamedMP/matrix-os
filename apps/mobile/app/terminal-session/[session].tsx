import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { mockColors, mockFonts } from "@/components/mock-shell/theme";

export default function TerminalSessionScreen() {
  const params = useLocalSearchParams<{ session?: string | string[] }>();
  const session = Array.isArray(params.session) ? params.session[0] : params.session;
  const [command, setCommand] = useState("");
  const [lastCommand, setLastCommand] = useState("git status --short");

  function runCommand() {
    const next = command.trim();
    if (!next) return;
    setLastCommand(next);
    setCommand("");
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Stack.Screen options={{ title: session || "terminal" }} />
      <View style={styles.statusBar}>
        <View style={styles.liveDot} />
        <Text style={styles.statusText}>CONNECTED · ~/matrix-os · main</Text>
      </View>
      <View style={styles.terminal}>
        <Text style={styles.line}>Matrix OS terminal mock</Text>
        <Text style={styles.mutedLine}>Last login: today from mobile</Text>
        <Text style={styles.prompt}>matrix@{session || "computer"} ~/matrix-os % {lastCommand}</Text>
        <Text style={styles.output}> M apps/mobile/app/_layout.tsx</Text>
        <Text style={styles.output}>?? apps/mobile/app/(drawer)/</Text>
        <Text style={styles.prompt}>matrix@{session || "computer"} ~/matrix-os % <Text style={styles.cursor}>▋</Text></Text>
      </View>
      <View style={styles.controls}>
        {['esc', 'tab', 'ctrl', '↑', '↓'].map((key) => (
          <Pressable key={key} style={styles.key}><Text style={styles.keyText}>{key}</Text></Pressable>
        ))}
        <Pressable accessibilityRole="button" accessibilityLabel="Paste" style={styles.key}>
          <Ionicons name="clipboard-outline" size={15} color={mockColors.surface} />
        </Pressable>
      </View>
      <View style={styles.commandBar}>
        <TextInput
          accessibilityLabel="Terminal command"
          value={command}
          onChangeText={setCommand}
          onSubmitEditing={runCommand}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Type a command"
          placeholderTextColor="#6F756F"
          returnKeyType="send"
          style={styles.commandInput}
        />
        <Pressable accessibilityRole="button" accessibilityLabel="Run command" onPress={runCommand} style={styles.runButton}>
          <Ionicons name="return-down-back" size={18} color={mockColors.terminal} />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: mockColors.terminal },
  statusBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#343834",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: mockColors.green },
  statusText: { fontFamily: mockFonts.mono, fontSize: 10, color: "#8D948D" },
  terminal: { flex: 1, paddingHorizontal: 16, paddingVertical: 18 },
  line: { fontFamily: mockFonts.mono, fontSize: 13, lineHeight: 21, color: mockColors.terminalInk },
  mutedLine: { fontFamily: mockFonts.mono, fontSize: 13, lineHeight: 21, color: "#727972", marginBottom: 16 },
  prompt: { fontFamily: mockFonts.mono, fontSize: 13, lineHeight: 21, color: mockColors.terminalInk },
  output: { fontFamily: mockFonts.mono, fontSize: 13, lineHeight: 21, color: "#ABB2AB" },
  cursor: { color: mockColors.blue },
  controls: { flexDirection: "row", gap: 6, paddingHorizontal: 10, paddingVertical: 8 },
  key: {
    minWidth: 42,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#414641",
    borderRadius: 9,
    paddingHorizontal: 9,
  },
  keyText: { fontFamily: mockFonts.mono, fontSize: 11, color: mockColors.surface },
  commandBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#343834",
    padding: 10,
  },
  commandInput: {
    flex: 1,
    minHeight: 44,
    borderWidth: 1,
    borderColor: "#414641",
    borderRadius: 12,
    paddingHorizontal: 13,
    fontFamily: mockFonts.mono,
    fontSize: 13,
    color: mockColors.surface,
  },
  runButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    backgroundColor: mockColors.terminalInk,
  },
});
