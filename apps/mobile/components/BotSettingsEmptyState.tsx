import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Link01Icon from "@hugeicons/core-free-icons/Link01Icon";
import Brain01Icon from "@hugeicons/core-free-icons/Brain01Icon";
import Clock01Icon from "@hugeicons/core-free-icons/Clock01Icon";
import { botSettingsEmptyStates, type BotSettingsSection } from "@matrix-os/contracts";
import { Icon } from "./ui/Icon";

const icons = { connections: Link01Icon, memory: Brain01Icon, routines: Clock01Icon };

export function BotSettingsEmptyState({ section }: { section: BotSettingsSection }) {
  const copy = botSettingsEmptyStates[section];
  return <View style={styles.card}>
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants"><Icon icon={icons[section]} size={24} /></View>
    <Text accessibilityRole="header" style={styles.heading}>{copy.title}</Text>
    <Text style={styles.description}>{copy.description}</Text>
    <Text style={styles.hint}>{copy.hint}</Text>
  </View>;
}

const styles = StyleSheet.create((theme) => ({
  card: { padding: 20, gap: 12, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 16 },
  heading: { fontSize: 16, fontWeight: "600", color: theme.colors.foreground },
  description: { fontSize: 13, lineHeight: 20, color: theme.colors.mutedForeground },
  hint: { fontSize: 13, lineHeight: 20, color: theme.colors.foreground },
}));
