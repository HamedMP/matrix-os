import type { ReactNode } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";

interface TabScreenProps {
  children: ReactNode;
  testID?: string;
}

/**
 * The frame of a screen inside the tabs. No navigator draws a header there, so
 * this is what keeps the screen's content below the status bar.
 */
export function TabScreen({ children, testID }: TabScreenProps) {
  const insets = useSafeAreaInsets();

  return (
    <View testID={testID} style={[styles.screen, { paddingTop: insets.top }]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.v2.colors.background,
  },
}));
