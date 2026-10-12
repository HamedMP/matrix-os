import type { ReactNode, Ref } from "react";
import { Platform, TextInput, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { AddIcon, IconButton, SendIcon, StopIcon } from "@/components/ui";

const TOOLBAR_ICON_SIZE = 18;
const STOP_ICON_SIZE = 16;

export interface ComposerProps {
  inputRef?: Ref<TextInput>;
  draft: string;
  onChangeDraft: (text: string) => void;
  placeholder: string;
  /** False while there is nobody to send as. */
  editable?: boolean;
  autoFocus?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
  canSend: boolean;
  onSend: () => void;
  /** A turn is running: the send button becomes a stop button. */
  running?: boolean;
  /** Stops the running turn. Left out while there is no run to stop yet. */
  onStop?: () => void;
  /** The engine and model control, after the attach button. */
  modelControl?: ReactNode;
  /** Whether the on-screen keyboard is showing, which the card then rests on. */
  keyboardOpen: boolean;
}

/** The message box pinned to the bottom of a chat: the input over a toolbar. */
export function Composer({
  inputRef,
  draft,
  onChangeDraft,
  placeholder,
  editable = true,
  autoFocus = false,
  onFocus,
  onBlur,
  canSend,
  onSend,
  running = false,
  onStop,
  modelControl,
  keyboardOpen,
}: ComposerProps) {
  const { theme } = useUnistyles();
  const { colors, radius, size } = theme.v2;
  const roundButton = { buttonSize: size.control, borderRadius: radius.full } as const;
  const actionButton = { ...roundButton, backgroundColor: colors.textDefault, iconColor: colors.background } as const;

  return (
    <View testID="composer" style={[styles.wrap, keyboardOpen && styles.wrapOnKeyboard]}>
      <View testID="composer-card" style={styles.card}>
        <TextInput
          ref={inputRef}
          accessibilityLabel="Message Matrix"
          value={draft}
          onChangeText={onChangeDraft}
          onSubmitEditing={onSend}
          onFocus={onFocus}
          onBlur={onBlur}
          placeholder={placeholder}
          placeholderTextColor={colors.textTertiary}
          // iOS colours the caret with the selection colour; Android has its own.
          selectionColor={Platform.OS === "ios" ? colors.success : undefined}
          cursorColor={colors.success}
          editable={editable}
          autoFocus={autoFocus}
          returnKeyType="send"
          style={styles.input}
        />
        <View testID="composer-toolbar" style={styles.toolbar}>
          <View testID="composer-toolbar-leading" style={styles.leading}>
            <IconButton
              {...roundButton}
              accessibilityLabel="Attach"
              icon={AddIcon}
              iconSize={TOOLBAR_ICON_SIZE}
              backgroundColor={colors.card}
            />
            {modelControl}
          </View>
          {running ? (
            <IconButton
              {...actionButton}
              accessibilityLabel="Stop"
              icon={StopIcon}
              iconSize={STOP_ICON_SIZE}
              disabled={!onStop}
              onPress={onStop}
            />
          ) : (
            <IconButton
              {...actionButton}
              accessibilityLabel="Send message"
              icon={SendIcon}
              iconSize={TOOLBAR_ICON_SIZE}
              disabled={!canSend}
              onPress={onSend}
            />
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: {
    paddingHorizontal: theme.v2.space[12],
    paddingBottom: theme.v2.space[10],
  },
  wrapOnKeyboard: {
    paddingBottom: theme.v2.space[8],
  },
  card: {
    borderWidth: theme.v2.borderWidth.hairline,
    borderColor: theme.v2.colors.borderHairline,
    borderRadius: theme.v2.radius.composer,
    backgroundColor: theme.v2.colors.background,
    boxShadow: theme.v2.designShadows.composer,
  },
  // The card's top and side padding, and the space above the toolbar, belong
  // to the input so that a tap anywhere in them focuses it. The line height is
  // left to the system: a single-line iOS input sets its text low when given one.
  input: {
    fontFamily: theme.v2.text.body.fontFamily,
    fontSize: theme.v2.text.body.fontSize,
    color: theme.v2.colors.textDefault,
    paddingTop: theme.v2.space[14],
    paddingHorizontal: theme.v2.space[14],
    paddingBottom: theme.v2.space[10],
    minHeight: theme.v2.space[14] + theme.v2.text.body.lineHeight + theme.v2.space[10],
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.v2.space[8],
    paddingHorizontal: theme.v2.space[14],
    paddingBottom: theme.v2.space[10],
  },
  leading: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[8],
  },
}));
