import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { CheckIcon, Icon, ProviderLogo } from "@/components/ui";
import { DISABLED_OPACITY, PRESSED_OPACITY } from "@/components/ui/pressable-state";

import type { ModelChoice } from "./model-choices";

const CHECK_SIZE = 18;

export interface ModelSheetRowProps {
  model: ModelChoice;
  /** Nothing can be chosen for now, whether or not this model can run. */
  disabled?: boolean;
  onPress: () => void;
}

/** One model in the sheet: its name over the route it runs through. */
export function ModelSheetRow({ model, disabled = false, onPress }: ModelSheetRowProps) {
  const { theme } = useUnistyles();
  const inert = disabled || !model.available;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[model.name, model.detail].filter(Boolean).join(", ")}
      accessibilityState={{ selected: model.selected, disabled: inert }}
      disabled={inert}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        model.selected && styles.selected,
        inert && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.text}>
        <Text numberOfLines={1} style={styles.name}>{model.name}</Text>
        <View testID="model-row-detail" style={styles.detailLine}>
          {/* The logo is as tall as the text it leads. */}
          <ProviderLogo provider={model.logo} size={theme.v2.text.footnote.fontSize} />
          <Text numberOfLines={1} style={styles.detail}>{model.detail}</Text>
        </View>
      </View>
      {model.selected ? <Icon icon={CheckIcon} size={CHECK_SIZE} color={theme.v2.colors.textDefault} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[10],
    padding: theme.v2.space[12],
    borderRadius: theme.v2.radius.card,
  },
  selected: {
    backgroundColor: theme.v2.colors.card,
  },
  text: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    ...theme.v2.text.bodyMedium,
    color: theme.v2.colors.textDefault,
  },
  detailLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[4],
    marginTop: theme.v2.space[2],
  },
  detail: {
    ...theme.v2.text.footnote,
    flexShrink: 1,
    color: theme.v2.colors.textSubtle,
  },
  disabled: {
    opacity: DISABLED_OPACITY,
  },
  pressed: {
    opacity: PRESSED_OPACITY,
  },
}));
