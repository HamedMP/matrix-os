import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import { ListRow, MockSearchField } from "@/components/mock-shell/MockControls";
import { MockPage } from "@/components/mock-shell/MockPage";
import { mockColors, mockFonts } from "@/components/mock-shell/theme";

export default function SearchScreen() {
  const router = useRouter();

  return (
    <MockPage title="Search" subtitle="Find anything across your Matrix computer">
      <MockSearchField placeholder="Files, sessions, apps, and chats" />
      <Text style={styles.sectionLabel}>SUGGESTED</Text>
      <View style={styles.list}>
        <ListRow title="matrix-os" detail="Folder · Projects" icon="folder-outline" onPress={() => router.push({ pathname: "/file-browser", params: { folder: "Projects" } } as never)} />
        <ListRow title="solar-vale" detail="Active terminal" icon="terminal-outline" accent={mockColors.blueSoft} onPress={() => router.push({ pathname: "/terminal-session/[session]", params: { session: "solar-vale" } } as never)} />
        <ListRow title="Notes" detail="Installed app" icon="document-text-outline" accent="#FFF1DD" onPress={() => router.push({ pathname: "/app-preview/[app]", params: { app: "Notes" } } as never)} />
      </View>
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
});
