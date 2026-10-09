import { Host, Picker } from "@expo/ui";
import { useUnistyles } from "react-native-unistyles";

export interface MenuPickerOption {
  label: string;
  value: string;
}

export interface MenuPickerProps {
  options: MenuPickerOption[];
  selectedValue: string;
  onValueChange: (value: string) => void;
  enabled?: boolean;
  /** Names the control for screen readers where the platform does not already. */
  accessibilityLabel?: string;
  /** Shown on the Android trigger when no option matches `selectedValue`. */
  placeholder?: string;
  /** Widest the selected label may grow before it is cut off (Android trigger). */
  maxLabelWidth?: number;
  testID?: string;
}

/**
 * Single-choice control that opens a native popup menu. iOS and web render
 * `@expo/ui`'s `Picker` (a SwiftUI menu picker on iOS). Android has its own
 * file: there the same `Picker` is a full Material text field, 280dp wide at
 * minimum, which does not fit beside other controls.
 */
export function MenuPicker({ options, selectedValue, onValueChange, enabled = true, testID }: MenuPickerProps) {
  const { theme } = useUnistyles();

  return (
    <Host matchContents seedColor={theme.v2.appColors.muted}>
      <Picker
        appearance="menu"
        selectedValue={selectedValue}
        onValueChange={onValueChange}
        enabled={enabled}
        testID={testID}
      >
        {options.map((option) => (
          <Picker.Item key={option.value} label={option.label} value={option.value} />
        ))}
      </Picker>
    </Host>
  );
}
