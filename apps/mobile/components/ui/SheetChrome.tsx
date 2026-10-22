import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { Button } from "./Button";

export interface SheetGrabberProps {
  testID?: string;
}

/** The handle at the top of a sheet that can be dragged. */
export function SheetGrabber({ testID }: SheetGrabberProps) {
  return (
    <View
      testID={testID}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={styles.grabber}
    />
  );
}

export interface SheetActionHeaderProps {
  title: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  cancelLabel?: string;
  confirmDisabled?: boolean;
  confirmLoading?: boolean;
  testID?: string;
}

/** Cancel at the left, the title between the buttons and the main action at the right. */
export function SheetActionHeader({
  title,
  confirmLabel,
  onConfirm,
  onCancel,
  cancelLabel = "Cancel",
  confirmDisabled = false,
  confirmLoading = false,
  testID,
}: SheetActionHeaderProps) {
  return (
    <View testID={testID} style={styles.header}>
      <Button variant="text" label={cancelLabel} onPress={onCancel} />
      <Text accessibilityRole="header" numberOfLines={1} style={styles.title}>
        {title}
      </Text>
      <Button
        label={confirmLabel}
        onPress={onConfirm}
        disabled={confirmDisabled}
        loading={confirmLoading}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  grabber: {
    width: theme.v2.size.grabberWidth,
    height: theme.v2.size.grabberHeight,
    alignSelf: "center",
    marginTop: theme.v2.space[10],
    borderRadius: theme.v2.radius.full,
    backgroundColor: theme.v2.colors.grabber,
  },
  // The title is centred in the space between the buttons, as the design draws
  // it, so it sits off the row's centre when the two labels differ in length.
  header: {
    height: theme.v2.size.control,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.v2.space[8],
  },
  title: {
    ...theme.v2.text.headline,
    flexShrink: 1,
    color: theme.v2.colors.textDefault,
  },
}));
