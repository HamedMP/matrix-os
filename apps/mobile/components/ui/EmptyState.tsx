import { Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { Icon, type IconData } from "./Icon";
import { Spacer } from "./Spacer";

export interface EmptyStateProps {
  icon: IconData;
  message: string;
  testID?: string;
  iconTestID?: string;
}

export function EmptyState({ icon, message, testID, iconTestID }: EmptyStateProps) {
  const { theme } = useUnistyles();

  return (
    <View testID={testID} style={styles.container}>
      <Icon
        icon={icon}
        size={48}
        color={theme.v2.colors.textSubtle}
        testID={iconTestID}
      />
      <Spacer size="md" />
      <Text style={styles.message}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  message: {
    fontFamily: theme.v2.fonts.body,
    fontSize: 16,
    color: theme.v2.colors.textSubtle,
    textAlign: "center",
  },
}));
