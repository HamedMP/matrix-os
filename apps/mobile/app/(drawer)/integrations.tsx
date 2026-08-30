import { Pressable, StyleSheet, Text, View } from "react-native";
import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import PuzzleIcon from "@hugeicons/core-free-icons/PuzzleIcon";
import { useRouter } from "expo-router";

import { Icon, Spacer } from "@/components/ui";
import { ListRow, ListRowStack } from "@/components/mock-shell/MockControls";
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
        <Spacer size="lg" />
        <View>
          <Text style={styles.cardEyebrow}>INSTALLED</Text>
          <Spacer size="xs" />
          <Text style={styles.cardTitle}>4 connected services</Text>
        </View>
        <Spacer size="lg" />
        <View style={styles.installedRow}>
          <View style={styles.iconStack}>
            {installedColors.map((color, index) => (
              <View key={color} style={[styles.installedIcon, { backgroundColor: color, marginLeft: index === 0 ? 0 : -7 }]} />
            ))}
          </View>
          <Icon icon={ArrowRight01Icon} size={20} color={mockColors.ink} />
        </View>
        <Spacer size="lg" />
      </Pressable>

      <Spacer size="2xl" />
      <Text style={styles.sectionLabel}>AVAILABLE</Text>
      <Spacer size="md" />
      <ListRowStack>
        {available.map((integration) => (
          <ListRow
            key={integration.name}
            title={integration.name}
            detail={integration.detail}
            icon={PuzzleIcon}
            accent={integration.color}
            actionIcon={Add01Icon}
            onPress={() => router.push({
              pathname: "/integration-detail/[integration]",
              params: { integration: integration.name },
            } as never)}
          />
        ))}
      </ListRowStack>
    </MockPage>
  );
}

const styles = StyleSheet.create({
  installedCard: {
    borderWidth: 1,
    borderColor: mockColors.line,
    borderRadius: 20,
    paddingHorizontal: 17,
    backgroundColor: mockColors.surface,
  },
  cardEyebrow: {
    fontFamily: mockFonts.semibold,
    fontSize: 11,
    letterSpacing: 1.2,
    color: mockColors.muted,
  },
  cardTitle: {
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
    fontFamily: mockFonts.semibold,
    fontSize: 11,
    letterSpacing: 1.1,
    color: mockColors.muted,
  },
  pressed: {
    opacity: 0.7,
  },
});
