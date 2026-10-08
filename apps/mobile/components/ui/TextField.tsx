import { useState } from "react";
import { TextInput, View, type TextInputProps } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { size } from "@/lib/theme-v2";

import { IconButton } from "./IconButton";
import { CloseIcon } from "./icons";

export interface TextFieldProps
  extends Pick<
    TextInputProps,
    | "placeholder"
    | "autoFocus"
    | "onSubmitEditing"
    | "returnKeyType"
    | "maxLength"
    | "editable"
    | "accessibilityLabel"
    | "testID"
  > {
  value: string;
  onChangeText: (value: string) => void;
  /** Shows a clear button while there is a value. */
  clearable?: boolean;
}

const CLEAR_ICON_SIZE = 18;
const CLEAR_SLOP = (size.tapTarget - CLEAR_ICON_SIZE) / 2;

/** Single-line text field. */
export function TextField({
  value,
  onChangeText,
  clearable = false,
  placeholder,
  editable,
  accessibilityLabel,
  testID,
  ...inputProps
}: TextFieldProps) {
  const { theme } = useUnistyles();
  const [focused, setFocused] = useState(false);
  const name = accessibilityLabel ?? placeholder;
  const showClear = clearable && editable !== false && value.length > 0;

  return (
    <View
      testID={testID ? `${testID}-container` : undefined}
      style={[styles.field, focused && styles.fieldFocused]}
    >
      <TextInput
        {...inputProps}
        testID={testID}
        accessibilityLabel={name}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.v2.colors.textTertiary}
        selectionColor={theme.v2.colors.success}
        cursorColor={theme.v2.colors.success}
        editable={editable}
        multiline={false}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={styles.input}
      />
      {showClear ? (
        <IconButton
          accessibilityLabel={name ? `Clear ${name}` : "Clear"}
          icon={CloseIcon}
          iconSize={CLEAR_ICON_SIZE}
          buttonSize={CLEAR_ICON_SIZE}
          hitSlop={CLEAR_SLOP}
          onPress={() => onChangeText("")}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  field: {
    height: theme.v2.size.field,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[8],
    borderRadius: theme.v2.radius.field,
    // Always present, so focusing the field does not move its content.
    borderWidth: theme.v2.borderWidth.emphasis,
    borderColor: "transparent",
    paddingHorizontal: theme.v2.space[14],
    backgroundColor: theme.v2.colors.card,
  },
  fieldFocused: {
    borderColor: theme.v2.colors.textDefault,
  },
  // A one-line input centres its own text; a line height would only offset it
  // and stretch the caret.
  input: {
    flex: 1,
    alignSelf: "stretch",
    fontFamily: theme.v2.text.headlineRegular.fontFamily,
    fontSize: theme.v2.text.headlineRegular.fontSize,
    color: theme.v2.colors.textDefault,
  },
}));
