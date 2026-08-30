import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import { ListRow, MockSearchField } from "@/components/mock-shell/MockControls";
import { MockPage } from "@/components/mock-shell/MockPage";
import { mockColors, mockFonts } from "@/components/mock-shell/theme";

const sessions = [
  { name: "solar-vale", detail: "~/matrix-os · main", accent: mockColors.blueSoft },
  { name: "swift-willow", detail: "~/projects/mobile · feature/drawer", accent: "#F2EAFE" },
  { name: "warm-vale", detail: "~ · idle", accent: "#FFF1DD" },
];

export default function TerminalScreen() {
  const router = useRouter();

  return (
    <MockPage title="Terminal" subtitle="Persistent sessions on this computer">
      <MockSearchField placeholder="Search sessions" />
      <Text style={styles.sectionLabel}>ACTIVE SESSIONS</Text>
      <View style={styles.list}>
        {sessions.map((session) => (
          <ListRow
            key={session.name}
            title={session.name}
            detail={session.detail}
            icon="terminal-outline"
            accent={session.accent}
            accessibilityLabel={`Open ${session.name} terminal`}
            onPress={() => router.push({
              pathname: "/terminal-session/[session]",
              params: { session: session.name },
            } as never)}
          />
        ))}
      </View>
      <Text style={styles.closed}>▾ Closed sessions</Text>
    </MockPage>
  );
}

const styles = StyleSheet.create({
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
  closed: {
    marginTop: 22,
    fontFamily: mockFonts.medium,
    fontSize: 14,
    color: mockColors.ink,
  },
});
