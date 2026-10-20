import { useEffect } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { warningHaptic } from "@/lib/haptics";

import { DISABLED_OPACITY } from "./pressable-state";
import { PressableScale } from "./PressableScale";
import { Spacer } from "./Spacer";

export interface ConfirmDialogField {
  accessibilityLabel: string;
  value: string;
  onChangeText: (value: string) => void;
  maxLength?: number;
}

export interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  /** What the action will do, in the person's terms. */
  message: string;
  confirmLabel: string;
  confirmAccessibilityLabel?: string;
  /** Names the area around the dialog, which cancels like Cancel does. */
  dismissAccessibilityLabel: string;
  /** For an action that removes something: a red action button, and the warning haptic as the dialog opens. */
  destructive?: boolean;
  /** While the action runs: both buttons wait, and so does the area around the dialog. */
  busy?: boolean;
  error?: string | null;
  /** A text field above the buttons, such as a new name. Return on the keyboard confirms. */
  field?: ConfirmDialogField;
  onCancel: () => void;
  onConfirm: () => void;
}

/** The app's one confirmation dialog: a card over the screen with Cancel and the action. */
export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel,
  confirmAccessibilityLabel,
  dismissAccessibilityLabel,
  destructive = false,
  busy = false,
  error = null,
  field,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const { theme } = useUnistyles();
  const cancel = () => {
    if (!busy) onCancel();
  };

  useEffect(() => {
    if (visible && destructive) warningHaptic();
  }, [visible, destructive]);

  return (
    <Modal transparent animationType="fade" visible={visible} onRequestClose={cancel}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.overlay}>
        <Pressable accessibilityLabel={dismissAccessibilityLabel} onPress={cancel} style={styles.backdrop} />
        <View accessibilityViewIsModal style={styles.card}>
          <Spacer size="xl" />
          <Text accessibilityRole="header" style={styles.title}>{title}</Text>
          <Spacer size="sm" />
          <Text style={styles.message}>{message}</Text>
          {field ? (
            <>
              <Spacer size="lg" />
              <TextInput
                accessibilityLabel={field.accessibilityLabel}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                editable={!busy}
                maxLength={field.maxLength}
                onChangeText={field.onChangeText}
                onSubmitEditing={onConfirm}
                returnKeyType="done"
                selectTextOnFocus
                value={field.value}
                placeholderTextColor={theme.v2.colors.textTertiary}
                style={styles.input}
              />
            </>
          ) : null}
          {error ? (
            <>
              <Spacer size="sm" />
              <Text accessibilityRole="alert" style={styles.error}>{error}</Text>
            </>
          ) : null}
          <Spacer size="xl" />
          <View style={styles.buttons}>
            <DialogButton label="Cancel" disabled={busy} onPress={onCancel} />
            <DialogButton
              label={confirmLabel}
              accessibilityLabel={confirmAccessibilityLabel}
              destructive={destructive}
              disabled={busy}
              onPress={onConfirm}
            />
          </View>
          <Spacer size="xl" />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function DialogButton({
  label,
  accessibilityLabel,
  destructive = false,
  disabled,
  onPress,
}: {
  label: string;
  accessibilityLabel?: string;
  destructive?: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, destructive ? styles.buttonDestructive : styles.buttonNeutral, disabled && styles.disabled]}
    >
      <Text style={[styles.buttonText, destructive && styles.buttonTextDestructive]}>{label}</Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create((theme) => ({
  overlay: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: theme.v2.space[24],
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.v2.colors.scrim,
  },
  card: {
    width: "100%",
    maxWidth: 420,
    alignSelf: "center",
    paddingHorizontal: theme.v2.space[20],
    backgroundColor: theme.v2.colors.background,
    borderWidth: theme.v2.borderWidth.hairline,
    borderColor: theme.v2.colors.borderSubtle,
    borderRadius: theme.v2.radius.container,
    boxShadow: theme.v2.designShadows.lg,
  },
  title: {
    fontFamily: theme.v2.fonts.semibold,
    fontSize: 19,
    color: theme.v2.colors.textDefault,
  },
  message: {
    ...theme.v2.text.label,
    color: theme.v2.colors.textSubtle,
  },
  input: {
    height: 48,
    paddingHorizontal: theme.v2.space[14],
    fontFamily: theme.v2.fonts.body,
    fontSize: 15,
    color: theme.v2.colors.textDefault,
    backgroundColor: theme.v2.colors.card,
    borderWidth: theme.v2.borderWidth.hairline,
    borderColor: theme.v2.colors.borderSubtle,
    borderRadius: theme.v2.radius.card,
  },
  error: {
    ...theme.v2.text.caption,
    color: theme.v2.colors.danger,
  },
  buttons: {
    flexDirection: "row",
    justifyContent: "flex-end",
    columnGap: theme.v2.space[8],
  },
  button: {
    minWidth: 88,
    height: theme.v2.size.control,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.v2.space[16],
    borderWidth: theme.v2.borderWidth.hairline,
    borderRadius: theme.v2.radius.card,
  },
  buttonNeutral: {
    backgroundColor: theme.v2.colors.controlOutline,
    borderColor: theme.v2.colors.controlOutlineBorder,
  },
  buttonDestructive: {
    backgroundColor: theme.v2.palette.coral[700],
    borderColor: theme.v2.palette.coral[700],
  },
  buttonText: {
    ...theme.v2.text.labelMedium,
    color: theme.v2.colors.onControl,
  },
  buttonTextDestructive: {
    color: theme.v2.palette.neutral[50],
  },
  disabled: {
    opacity: DISABLED_OPACITY,
  },
}));
