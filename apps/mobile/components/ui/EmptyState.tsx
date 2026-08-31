import { StyleSheet, Text, View } from "react-native";

import { Icon, type IconData } from "./Icon";
import { Spacer } from "./Spacer";
import { fonts, semanticColors } from "@/lib/theme";

export interface EmptyStateProps {
  icon: IconData;
  message: string;
  testID?: string;
  iconTestID?: string;
}

export function EmptyState({ icon, message, testID, iconTestID }: EmptyStateProps) {
  return (
    <View testID={testID} style={styles.container}>
      <Icon
        icon={icon}
        size={48}
        color={semanticColors.textSubtle}
        testID={iconTestID}
      />
      <Spacer size="md" />
      <Text style={styles.message}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  message: {
    fontFamily: fonts.product,
    fontSize: 16,
    color: semanticColors.textSubtle,
    textAlign: "center",
  },
});
