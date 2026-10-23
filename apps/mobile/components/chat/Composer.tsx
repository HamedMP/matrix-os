import type { ReactNode, Ref } from "react";
import { Platform, Text, TextInput, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { IconButton, SendIcon, StopIcon } from "@/components/ui";
import type { ComposerAttachment } from "@/lib/chat-attachments";
import { isComposerSpeechBusy, type ComposerSpeech } from "@/lib/speech/composer-speech";

import { AttachmentTray } from "./AttachmentTray";
import { SpeechButton, SpeechToolbarStatus } from "./ComposerSpeechControls";
import { useInputRelayout } from "./use-input-relayout";

const TOOLBAR_ICON_SIZE = 18;
const STOP_ICON_SIZE = 16;
/** How many lines the input grows to before its text scrolls inside it. */
const MAX_INPUT_LINES = 6;

// What the empty input says while dictation holds it, in the web app's words.
const SPEECH_PLACEHOLDERS: Partial<Record<ComposerSpeech["phase"], string>> = {
  requesting_permission: "Waiting for microphone permission...",
  recording: "Recording — stop when you're done",
  transcribing: "Transcribing into an editable draft...",
};

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
  /** The photos and files waiting to go with the message, in a row above the input. */
  attachments?: readonly ComposerAttachment[];
  onRemoveAttachment?: (id: string) => void;
  /** Why the message cannot be sent with what is waiting, said under the attachments. */
  attachmentNotice?: string | null;
  /** The "+" that adds to the message, at the start of the toolbar. */
  addControl?: ReactNode;
  /** The engine and model control, after the "+". */
  modelControl?: ReactNode;
  /** Dictation into the draft, with its microphone before send. Left out, there is no microphone. */
  speech?: ComposerSpeech;
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
  attachments,
  onRemoveAttachment,
  attachmentNotice,
  addControl,
  modelControl,
  speech,
  keyboardOpen,
}: ComposerProps) {
  const { theme } = useUnistyles();
  const { colors } = theme.v2;
  // While recording or transcribing, dictation stands in for the add and model controls.
  const speechStatus = speech?.phase === "recording" || speech?.phase === "transcribing" ? speech : null;
  // Grows to fit text the app puts in (dictation, a suggestion) as it does for typing.
  const { handleChangeText, minHeightNudge } = useInputRelayout(draft, onChangeDraft);

  return (
    <View testID="composer" style={[styles.wrap, keyboardOpen && styles.wrapOnKeyboard]}>
      <View testID="composer-card" style={styles.card}>
        {attachments && onRemoveAttachment ? (
          <AttachmentTray attachments={attachments} onRemove={onRemoveAttachment} />
        ) : null}
        {attachmentNotice ? (
          <Text testID="composer-attachment-notice" accessibilityRole="alert" style={styles.attachmentNotice}>
            {attachmentNotice}
          </Text>
        ) : null}
        {speech?.error ? (
          <Text testID="composer-speech-error" accessibilityRole="alert" style={styles.speechError}>
            {speech.error}
          </Text>
        ) : null}
        {/* Return starts a new line; only the button sends. */}
        <TextInput
          ref={inputRef}
          accessibilityLabel="Message Matrix"
          multiline
          value={draft}
          onChangeText={handleChangeText}
          onFocus={onFocus}
          onBlur={onBlur}
          placeholder={(speech && SPEECH_PLACEHOLDERS[speech.phase]) ?? placeholder}
          placeholderTextColor={colors.textTertiary}
          // iOS colours the caret with the selection colour; Android has its own.
          selectionColor={Platform.OS === "ios" ? colors.success : undefined}
          cursorColor={colors.success}
          editable={editable}
          autoFocus={autoFocus}
          style={styles.input(minHeightNudge)}
        />
        <View testID="composer-toolbar" style={styles.toolbar}>
          <View testID="composer-toolbar-leading" style={styles.leading}>
            {speechStatus ? <SpeechToolbarStatus speech={speechStatus} /> : (
              <>
                {addControl}
                {modelControl}
              </>
            )}
          </View>
          <View testID="composer-toolbar-trailing" style={styles.trailing}>
            {speech ? <SpeechButton speech={speech} disabled={!editable} /> : null}
            <PrimaryAction speech={speech} running={running} onStop={onStop} canSend={canSend} onSend={onSend} />
          </View>
        </View>
      </View>
    </View>
  );
}

/**
 * The round button at the end of the toolbar: it finishes a recording, stops a
 * running turn, or sends. The message waits while dictation is filling it.
 */
function PrimaryAction({ speech, running, onStop, canSend, onSend }: {
  speech: ComposerSpeech | undefined;
  running: boolean;
  onStop: (() => void) | undefined;
  canSend: boolean;
  onSend: () => void;
}) {
  const { theme } = useUnistyles();
  const { colors, radius, size } = theme.v2;
  const actionButton = {
    buttonSize: size.control,
    borderRadius: radius.full,
    backgroundColor: colors.textDefault,
    iconColor: colors.background,
  } as const;

  if (speech?.phase === "recording") {
    return (
      <IconButton
        {...actionButton}
        accessibilityLabel="Stop recording"
        icon={StopIcon}
        iconSize={STOP_ICON_SIZE}
        onPress={speech.stop}
      />
    );
  }
  if (running) {
    return (
      <IconButton
        {...actionButton}
        accessibilityLabel="Stop"
        icon={StopIcon}
        iconSize={STOP_ICON_SIZE}
        disabled={!onStop}
        onPress={onStop}
      />
    );
  }
  return (
    <IconButton
      {...actionButton}
      accessibilityLabel="Send message"
      icon={SendIcon}
      iconSize={TOOLBAR_ICON_SIZE}
      disabled={!canSend || isComposerSpeechBusy(speech)}
      onPress={onSend}
    />
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
  attachmentNotice: {
    ...theme.v2.text.footnote,
    color: theme.v2.colors.textSubtle,
    paddingTop: theme.v2.space[8],
    paddingHorizontal: theme.v2.space[14],
  },
  // The card's top and side padding, and the space above the toolbar, belong
  // to the input so that a tap anywhere in them focuses it. It is one line
  // high when empty and grows with the draft up to MAX_INPUT_LINES, after
  // which the text scrolls inside it.
  input: (minHeightNudge: number) => ({
    fontFamily: theme.v2.text.body.fontFamily,
    fontSize: theme.v2.text.body.fontSize,
    lineHeight: theme.v2.text.body.lineHeight,
    color: theme.v2.colors.textDefault,
    textAlignVertical: "top",
    paddingTop: theme.v2.space[14],
    paddingHorizontal: theme.v2.space[14],
    paddingBottom: theme.v2.space[10],
    minHeight: theme.v2.space[14] + theme.v2.text.body.lineHeight + theme.v2.space[10] + minHeightNudge,
    maxHeight: theme.v2.space[14] + MAX_INPUT_LINES * theme.v2.text.body.lineHeight + theme.v2.space[10],
  }),
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
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[8],
  },
  speechError: {
    ...theme.v2.text.footnote,
    color: theme.v2.colors.danger,
    paddingTop: theme.v2.space[8],
    paddingHorizontal: theme.v2.space[14],
  },
}));
