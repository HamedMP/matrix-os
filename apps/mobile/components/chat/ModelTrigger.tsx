import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { DisclosureDownIcon, Icon, ProviderLogo, type Provider } from "@/components/ui";
import { DISABLED_OPACITY, PRESSED_OPACITY } from "@/components/ui/pressable-state";

import { Spinner } from "./Spinner";

/** The size of the logo and of the chevron. */
export const MODEL_TRIGGER_ICON_SIZE = 14;

export interface ModelTriggerProps {
  /** The engine whose logo leads the label. Left out while nothing is chosen. */
  provider?: Provider;
  label: string;
  /** The models are being checked: a spinner takes the chevron's place. */
  loading?: boolean;
  disabled?: boolean;
  /** The model cannot be changed here: a plain label, no chevron. */
  fixed?: boolean;
  /** Opens the model sheet. A fixed trigger has none. */
  onPress?: () => void;
  /** A limit for the label where the trigger's own room does not cut it off. */
  maxLabelWidth?: number;
  testID?: string;
}

/** The composer's engine and model control: logo, "engine · model", chevron. */
export function ModelTrigger({
  provider,
  label,
  loading = false,
  disabled = false,
  fixed = false,
  onPress,
  maxLabelWidth,
  testID,
}: ModelTriggerProps) {
  const { theme } = useUnistyles();

  const content = (
    <>
      {provider ? <ProviderLogo provider={provider} size={MODEL_TRIGGER_ICON_SIZE} /> : null}
      <Text
        numberOfLines={1}
        style={[styles.label, maxLabelWidth !== undefined && { maxWidth: maxLabelWidth }]}
      >
        {label}
      </Text>
      {loading ? (
        <Spinner
          size={MODEL_TRIGGER_ICON_SIZE}
          color={theme.v2.colors.textSubtle}
          accessibilityLabel="Checking model availability"
        />
      ) : fixed ? null : (
        <Icon icon={DisclosureDownIcon} size={MODEL_TRIGGER_ICON_SIZE} color={theme.v2.colors.textSubtle} />
      )}
    </>
  );

  if (fixed) {
    return <View testID={testID} style={styles.trigger}>{content}</View>;
  }

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel="Model"
      accessibilityValue={{ text: label }}
      accessibilityState={{ disabled, busy: loading }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.trigger, disabled && styles.disabled, pressed && styles.pressed]}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    height: theme.v2.size.control,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[6],
    borderRadius: theme.v2.radius.control,
    paddingHorizontal: theme.v2.space[10],
  },
  label: {
    ...theme.v2.text.label,
    flexShrink: 1,
    color: theme.v2.colors.textDefault,
  },
  disabled: {
    opacity: DISABLED_OPACITY,
  },
  pressed: {
    opacity: PRESSED_OPACITY,
  },
}));
