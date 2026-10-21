import { ActivityIndicator, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { CloseIcon, IconButton, MicIcon } from "@/components/ui";
import { formatSpeechElapsed, type ComposerSpeech } from "@/lib/speech/composer-speech";

import { SpeechWaveform } from "./SpeechWaveform";

const ICON_SIZE = 18;

/**
 * What stands in the toolbar for the add and model controls while dictation
 * fills the draft: the recording's waveform and time, or that it is being
 * transcribed.
 */
export function SpeechToolbarStatus({ speech }: { speech: ComposerSpeech }) {
  const { theme } = useUnistyles();
  if (speech.phase === "recording") {
    const elapsed = formatSpeechElapsed(speech.elapsedMs);
    return (
      <View accessible accessibilityLabel={`Recording, ${elapsed}`} style={styles.status}>
        <SpeechWaveform level={speech.inputLevel} sampleSequence={speech.inputLevelSequence} />
        <Text style={styles.elapsed}>{elapsed}</Text>
      </View>
    );
  }
  return (
    <View style={styles.status}>
      <ActivityIndicator size="small" color={theme.v2.colors.textSubtle} />
      <Text accessibilityLiveRegion="polite" style={styles.label}>Transcribing…</Text>
    </View>
  );
}

/**
 * The microphone before send: starts dictation, waits on the permission
 * prompt, and drops the recording or the transcription on its way.
 */
export function SpeechButton({ speech, disabled }: { speech: ComposerSpeech; disabled: boolean }) {
  const { theme } = useUnistyles();
  const { colors, radius, size } = theme.v2;
  const quiet = {
    buttonSize: size.control,
    borderRadius: radius.full,
    backgroundColor: colors.card,
    iconColor: colors.textDefault,
    iconSize: ICON_SIZE,
  } as const;

  if (speech.phase === "recording" || speech.phase === "transcribing") {
    return (
      <IconButton
        {...quiet}
        accessibilityLabel={speech.phase === "recording" ? "Cancel recording" : "Cancel transcription"}
        icon={CloseIcon}
        onPress={speech.cancel}
      />
    );
  }
  const waiting = speech.phase === "requesting_permission";
  return (
    <IconButton
      {...quiet}
      accessibilityLabel={waiting ? "Waiting for microphone permission" : "Start voice input"}
      icon={MicIcon}
      loading={waiting}
      spinnerColor={colors.textDefault}
      disabled={disabled}
      onPress={speech.start}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  // As tall as the controls it stands in for, so the toolbar does not move.
  status: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[8],
    minHeight: theme.v2.size.control,
  },
  elapsed: {
    ...theme.v2.text.caption,
    color: theme.v2.colors.textSubtle,
    fontVariant: ["tabular-nums"],
  },
  label: {
    ...theme.v2.text.caption,
    color: theme.v2.colors.textSubtle,
  },
}));
