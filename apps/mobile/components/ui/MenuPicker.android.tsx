import { useState } from "react";
import { Host } from "@expo/ui";
import { DropdownMenu, DropdownMenuItem, RNHostView, Text as ComposeText } from "@expo/ui/jetpack-compose";
import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import { Pressable, Text } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { Icon } from "./Icon";
import type { MenuPickerProps } from "./MenuPicker";

const DEFAULT_MAX_LABEL_WIDTH = 160;

/**
 * Android `MenuPicker`: a compact label-and-chevron trigger that opens a
 * Material dropdown anchored to it. The trigger is a React Native view so it
 * takes the app theme and its own width, rather than `Picker`'s text field.
 */
export function MenuPicker({
  options,
  selectedValue,
  onValueChange,
  enabled = true,
  accessibilityLabel,
  placeholder = "",
  maxLabelWidth = DEFAULT_MAX_LABEL_WIDTH,
  testID,
}: MenuPickerProps) {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = useState(false);
  // A menu left open when the picker is disabled would still offer its items,
  // and would reopen by itself once the picker is enabled again.
  if (expanded && !enabled) setExpanded(false);
  const menuOpen = expanded && enabled;
  const selectedLabel = options.find((option) => option.value === selectedValue)?.label ?? placeholder;

  function handleSelect(value: string) {
    // The native menu can still deliver a tap that began before it closed.
    if (!enabled) return;
    setExpanded(false);
    onValueChange(value);
  }

  return (
    <Host matchContents>
      <DropdownMenu
        expanded={menuOpen}
        onDismissRequest={() => setExpanded(false)}
        color={theme.v2.appColors.surface}
      >
        <DropdownMenu.Trigger>
          <RNHostView matchContents>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={accessibilityLabel}
              accessibilityValue={{ text: selectedLabel }}
              accessibilityState={{ disabled: !enabled, expanded: menuOpen }}
              disabled={!enabled}
              onPress={() => setExpanded(true)}
              style={({ pressed }) => [styles.trigger, (pressed || !enabled) && styles.triggerDimmed]}
              testID={testID}
            >
              <Text
                numberOfLines={1}
                style={[styles.label, { maxWidth: maxLabelWidth }]}
                testID={testID ? `${testID}-label` : undefined}
              >
                {selectedLabel}
              </Text>
              <Icon icon={ArrowDown01Icon} size={14} color={theme.v2.appColors.muted} />
            </Pressable>
          </RNHostView>
        </DropdownMenu.Trigger>
        <DropdownMenu.Items>
          {options.map((option) => (
            <DropdownMenuItem
              key={option.value}
              elementColors={{ textColor: theme.v2.appColors.ink, trailingIconColor: theme.v2.appColors.ink }}
              onClick={() => handleSelect(option.value)}
            >
              <DropdownMenuItem.Text>
                <ComposeText>{option.label}</ComposeText>
              </DropdownMenuItem.Text>
              {option.value === selectedValue ? (
                <DropdownMenuItem.TrailingIcon>
                  <ComposeText>✓</ComposeText>
                </DropdownMenuItem.TrailingIcon>
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenu.Items>
      </DropdownMenu>
    </Host>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: theme.v2.appColors.line,
    borderRadius: 12,
    backgroundColor: theme.v2.appColors.surface,
  },
  triggerDimmed: {
    opacity: 0.55,
  },
  label: {
    flexShrink: 1,
    fontFamily: theme.v2.fonts.medium,
    fontSize: 13,
    color: theme.v2.appColors.ink,
  },
}));
