import type { ReactNode } from "react";
import {
  BottomSheet as ExpoBottomSheet,
  RNHostView,
  type SnapPoint,
} from "@expo/ui";
import { presentationBackground } from "@expo/ui/swift-ui/modifiers";
import { Platform, useWindowDimensions, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
  snapPoints?: SnapPoint[];
  showDragIndicator?: boolean;
  testID?: string;
}

/** Native modal sheet controlled independently from whichever view triggers it. */
export function Sheet({
  visible,
  onClose,
  children,
  snapPoints,
  showDragIndicator = false,
  testID,
}: SheetProps) {
  const { width } = useWindowDimensions();
  const { theme } = useUnistyles();
  const solidSheetModifiers = Platform.OS === "ios"
    ? [presentationBackground(theme.v2.colors.background)]
    : undefined;

  return (
    <ExpoBottomSheet
      isPresented={visible}
      onDismiss={onClose}
      showDragIndicator={showDragIndicator}
      snapPoints={snapPoints}
      contentPadding={0}
      modifiers={solidSheetModifiers}
      testID={testID}
    >
      <RNHostView matchContents>
        <View
          testID={testID ? `${testID}-content` : undefined}
          style={[styles.content, { width }]}
        >
          {children}
        </View>
      </RNHostView>
    </ExpoBottomSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: {
    backgroundColor: theme.v2.colors.background,
  },
}));
