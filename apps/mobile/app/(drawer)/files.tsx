import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import { GridTile, MockSearchField } from "@/components/mock-shell/MockControls";
import { MockPage } from "@/components/mock-shell/MockPage";
import { mockColors, mockFonts } from "@/components/mock-shell/theme";

const folders = ["Projects", "Documents", "Photos", "Downloads", "Shared", "Archive"];

export default function FilesScreen() {
  const router = useRouter();

  return (
    <MockPage title="Files" subtitle="Everything on solar-vale">
      <MockSearchField placeholder="Search files" />
      <View style={styles.sectionHeading}>
        <Text style={styles.sectionTitle}>Folders</Text>
        <Text style={styles.sectionMeta}>6 items</Text>
      </View>
      <View style={styles.grid}>
        {folders.map((folder, index) => (
          <GridTile
            key={folder}
            label={folder}
            icon={index === 0 ? "folder-open-outline" : "folder-outline"}
            accent={index === 0}
            accessibilityLabel={`Open ${folder} folder`}
            onPress={() => router.push({ pathname: "/file-browser", params: { folder } } as never)}
          />
        ))}
      </View>
    </MockPage>
  );
}

const styles = StyleSheet.create({
  sectionHeading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 28,
    marginBottom: 12,
  },
  sectionTitle: {
    fontFamily: mockFonts.semibold,
    fontSize: 14,
    color: mockColors.ink,
  },
  sectionMeta: {
    fontFamily: mockFonts.body,
    fontSize: 12,
    color: mockColors.muted,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
});
