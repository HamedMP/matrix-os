import "@/lib/hermes-polyfills";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ListRenderItemInfo,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth, useUser } from "@clerk/clerk-expo";
import { Image } from "expo-image";
import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import ArrowUp01Icon from "@hugeicons/core-free-icons/ArrowUp01Icon";

import { useCanonicalChatSession } from "@/lib/canonical-chat-session-context";
import { useCanonicalChatDetail } from "@/lib/queries/use-canonical-chat-detail";
import { useChatProviderCatalog } from "@/lib/queries/use-chat-provider-catalog";
import { useSendChatMessage } from "@/lib/queries/use-send-chat-message";
import { buildTranscript, type TranscriptMessage } from "@/lib/canonical-chat-transcript";
import { defaultCatalogSelection } from "@/lib/canonical-chat-selection";
import { ModelPicker } from "@/components/ModelPicker";
import { Icon, IconButton } from "@/components/ui";
import { mockColors, mockFonts } from "@/components/mock-shell/theme";
import { AnalyticsMask } from "@/lib/analytics";

const rabbitArtwork = require("../../assets/app.icon/Assets/rabbit.svg");

export default function ChatScreen() {
  const { isSignedIn } = useAuth();
  const { user } = useUser();
  const { activeChatId, selectionOverride, setSelectionOverride } = useCanonicalChatSession();
  const firstName = user?.firstName
    ?? user?.fullName?.trim().split(/\s+/)[0]
    ?? user?.username
    ?? "there";

  const { detail } = useCanonicalChatDetail(activeChatId);
  const { catalog } = useChatProviderCatalog();
  const sendMessage = useSendChatMessage();

  const selection = selectionOverride
    ?? detail?.record.chat.currentSelection
    ?? defaultCatalogSelection(catalog);

  const messages = useMemo(() => buildTranscript(detail), [detail]);
  const busy = sendMessage.isPending || (detail?.runs.some(
    (run) => !["completed", "failed", "aborted"].includes(run.status),
  ) ?? false);

  const [draft, setDraft] = useState("");
  const [inputFocused, setInputFocused] = useState(false);
  // Tapping the model picker itself blurs the TextInput a beat before its
  // native menu opens — delay hiding on blur, and cancel the hide entirely
  // if that blur was caused by touching the picker.
  const hidePickerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pickerTouchedRef = useRef(false);

  const handleInputFocus = useCallback(() => {
    if (hidePickerTimer.current) {
      clearTimeout(hidePickerTimer.current);
      hidePickerTimer.current = null;
    }
    setInputFocused(true);
  }, []);

  const handleInputBlur = useCallback(() => {
    hidePickerTimer.current = setTimeout(() => {
      hidePickerTimer.current = null;
      if (pickerTouchedRef.current) {
        pickerTouchedRef.current = false;
        return;
      }
      setInputFocused(false);
    }, 250);
  }, []);

  const handlePickerTouchStart = useCallback(() => {
    pickerTouchedRef.current = true;
  }, []);

  const isConnected = Boolean(isSignedIn);
  const hasDraftText = draft.trim().length > 0;
  const canSend = hasDraftText && isConnected && Boolean(selection) && !busy;

  const send = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed || !selection) return;
    setDraft("");
    sendMessage.mutate({
      chatId: activeChatId,
      baseRevision: detail?.record.chat.revision ?? 0,
      text: trimmed,
      selection,
    });
  }, [draft, selection, activeChatId, detail?.record.chat.revision, sendMessage]);

  const insets = useSafeAreaInsets();

  const renderItem = useCallback(({ item }: ListRenderItemInfo<TranscriptMessage>) => (
    <AnalyticsMask>
      <MessageBubble message={item} />
    </AnalyticsMask>
  ), []);

  const keyExtractor = useCallback((item: TranscriptMessage) => item.id, []);

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={84}
    >
      <FlatList
        style={styles.hero}
        data={messages}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        inverted
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
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
        }
      />

      <View style={[styles.composerWrap, { paddingBottom: Math.max(insets.bottom, 12) + 8 }]}>
        <View style={inputFocused ? styles.composerActive : styles.composer}>
          {inputFocused ? null : (
            <IconButton
              accessibilityLabel="Attach"
              icon={Add01Icon}
              iconSize={23}
              iconColor={mockColors.ink}
            />
          )}
          <TextInput
            accessibilityLabel="Message Matrix"
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={send}
            onFocus={handleInputFocus}
            onBlur={handleInputBlur}
            placeholder={isConnected ? "Message Matrix" : "Signing in…"}
            placeholderTextColor={mockColors.muted}
            editable={isConnected}
            returnKeyType="send"
            style={inputFocused ? styles.inputActive : styles.input}
          />
          {inputFocused ? (
            <View style={styles.composerControlsRow}>
              <IconButton
                accessibilityLabel="Attach"
                icon={Add01Icon}
                iconSize={23}
                iconColor={mockColors.ink}
              />
              <View style={styles.composerControlsRight}>
                <View onTouchStart={handlePickerTouchStart}>
                  <ModelPicker
                    catalog={catalog}
                    selection={selection}
                    onSelectionChange={setSelectionOverride}
                  />
                </View>
                <IconButton
                  accessibilityLabel={busy ? "Matrix is responding" : "Send message"}
                  icon={ArrowUp01Icon}
                  iconSize={19}
                  iconColor={mockColors.surface}
                  backgroundColor={canSend || busy ? mockColors.blue : "#B7BAB7"}
                  loading={busy}
                  disabled={!canSend}
                  onPress={send}
                />
              </View>
            </View>
          ) : (
            <IconButton
              accessibilityLabel={busy ? "Matrix is responding" : "Send message"}
              icon={ArrowUp01Icon}
              iconSize={19}
              iconColor={mockColors.surface}
              backgroundColor={canSend || busy ? mockColors.blue : "#B7BAB7"}
              loading={busy}
              disabled={!canSend}
              onPress={send}
            />
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function MessageBubble({ message }: { message: TranscriptMessage }) {
  if (message.role === "user") {
    return (
      <View style={styles.userBubble}>
        <Text style={styles.userText}>{message.text}</Text>
      </View>
    );
  }
  if (message.role === "tool") {
    return (
      <View style={styles.toolRow}>
        <Text style={styles.toolText}>{message.text}</Text>
      </View>
    );
  }
  if (message.role === "system") {
    return (
      <View style={styles.systemRow}>
        <Text style={styles.systemText}>{message.text}</Text>
      </View>
    );
  }
  return <AssistantMessage message={message} />;
}

function AssistantMessage({ message }: { message: TranscriptMessage }) {
  const [expanded, setExpanded] = useState(false);
  const hasWork = message.toolCalls.length > 0;
  const workedLabel = message.isRunning
    ? "Working…"
    : message.elapsedSeconds != null
      ? `Worked ${message.elapsedSeconds}s`
      : null;

  return (
    <View style={styles.matrixBubble}>
      {workedLabel ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={hasWork ? (expanded ? "Hide work" : "Show work") : workedLabel}
          disabled={!hasWork}
          onPress={() => setExpanded((value) => !value)}
          style={({ pressed }) => [styles.workedRow, pressed && hasWork && styles.pressed]}
        >
          <Text style={styles.workedText}>{workedLabel}</Text>
          {hasWork ? (
            <Icon
              icon={expanded ? ArrowUp01Icon : ArrowDown01Icon}
              size={14}
              color={mockColors.muted}
            />
          ) : null}
        </Pressable>
      ) : null}
      {expanded && hasWork ? (
        <View style={styles.toolCallsList}>
          {message.toolCalls.map((call) => (
            <Text key={call.id} style={styles.toolText}>{call.label}</Text>
          ))}
        </View>
      ) : null}
      {workedLabel ? <View style={styles.divider} /> : null}
      <Text style={styles.matrixText}>{message.text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: mockColors.canvas,
  },
  hero: {
    flex: 1,
  },
  listContent: {
    flexGrow: 1,
    justifyContent: "flex-end",
    paddingHorizontal: 24,
    paddingVertical: 18,
    gap: 18,
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
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
  pressed: {
    opacity: 0.6,
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
    width: "100%",
    alignSelf: "stretch",
  },
  workedRow: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    paddingVertical: 4,
  },
  workedText: {
    fontFamily: mockFonts.medium,
    fontSize: 13,
    color: mockColors.muted,
  },
  toolCallsList: {
    gap: 4,
    paddingBottom: 8,
  },
  divider: {
    height: 1,
    backgroundColor: mockColors.line,
    marginVertical: 10,
  },
  matrixText: {
    fontFamily: mockFonts.body,
    fontSize: 15,
    lineHeight: 22,
    color: mockColors.ink,
  },
  toolRow: {
    alignSelf: "flex-start",
  },
  toolText: {
    fontFamily: mockFonts.medium,
    fontSize: 13,
    color: mockColors.muted,
  },
  systemRow: {
    alignSelf: "center",
  },
  systemText: {
    fontFamily: mockFonts.medium,
    fontSize: 13,
    color: mockColors.muted,
    textAlign: "center",
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
  composerActive: {
    flexDirection: "column",
    gap: 6,
    borderWidth: 1,
    borderColor: mockColors.line,
    borderRadius: 22,
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 6,
    backgroundColor: mockColors.surface,
    boxShadow: "0 8px 24px rgba(23, 25, 24, 0.08)",
  },
  inputActive: {
    alignSelf: "stretch",
    minHeight: 40,
    paddingHorizontal: 4,
    fontFamily: mockFonts.body,
    fontSize: 15,
    color: mockColors.ink,
  },
  composerControlsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  composerControlsRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
});
