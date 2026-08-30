import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { ListRow } from "@/components/mock-shell/MockControls";
import { MockPage } from "@/components/mock-shell/MockPage";
import { mockColors, mockFonts } from "@/components/mock-shell/theme";

const installedColors = ["#E4C7FF", "#FFD0D0", "#FFE3B3", "#BDDFFF"];
const available = [
  { name: "GitHub", detail: "Repositories, pull requests, and issues", color: "#E8EAE8" },
  { name: "Linear", detail: "Projects, issues, and roadmaps", color: "#E9E2FF" },
  { name: "Google Drive", detail: "Files and shared documents", color: "#E4F4E8" },
];

export default function IntegrationsScreen() {
  const router = useRouter();

  return (
    <MockPage title="Integrations" subtitle="Capabilities Matrix can use on your behalf">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="View installed integrations"
        onPress={() => router.push("/integrations-installed" as never)}
        style={({ pressed }) => [styles.installedCard, pressed && styles.pressed]}
      >
        <View>
          <Text style={styles.cardEyebrow}>INSTALLED</Text>
          <Text style={styles.cardTitle}>4 connected services</Text>
        </View>
        <View style={styles.installedRow}>
          <View style={styles.iconStack}>
            {installedColors.map((color, index) => (
              <View key={color} style={[styles.installedIcon, { backgroundColor: color, marginLeft: index === 0 ? 0 : -7 }]} />
            ))}
          </View>
          <Ionicons name="arrow-forward" size={20} color={mockColors.ink} />
        </View>
      </Pressable>

      <Text style={styles.sectionLabel}>AVAILABLE</Text>
      <View style={styles.list}>
        {available.map((integration) => (
          <ListRow
            key={integration.name}
            title={integration.name}
            detail={integration.detail}
            icon="extension-puzzle-outline"
            accent={integration.color}
            actionIcon="add"
            onPress={() => router.push({
              pathname: "/integration-detail/[integration]",
              params: { integration: integration.name },
            } as never)}
          />
        ))}
      </View>
    </MockPage>
  );
}

const styles = StyleSheet.create({
  installedCard: {
    minHeight: 128,
    justifyContent: "space-between",
    borderWidth: 1,
    borderColor: mockColors.line,
    borderRadius: 20,
    padding: 17,
    backgroundColor: mockColors.surface,
  },
  cardEyebrow: {
    fontFamily: mockFonts.semibold,
    fontSize: 11,
    letterSpacing: 1.2,
    color: mockColors.muted,
  },
  cardTitle: {
    marginTop: 5,
    fontFamily: mockFonts.display,
    fontSize: 20,
    color: mockColors.ink,
  },
  installedRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  iconStack: {
    flexDirection: "row",
  },
  installedIcon: {
    width: 32,
    height: 32,
    borderWidth: 2,
    borderColor: mockColors.surface,
    borderRadius: 10,
  },
  sectionLabel: {
    marginTop: 28,
    marginBottom: 10,
    fontFamily: mockFonts.semibold,
    fontSize: 11,
    letterSpacing: 1.1,
    color: mockColors.muted,
  },
  list: {
    gap: 10,
  },
  pressed: {
    opacity: 0.7,
  },
});
