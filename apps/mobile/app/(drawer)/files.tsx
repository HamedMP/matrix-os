import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import Folder01Icon from "@hugeicons/core-free-icons/Folder01Icon";

import { GridTile, GridTileGrid, MockSearchField } from "@/components/mock-shell/MockControls";
import { MockPage } from "@/components/mock-shell/MockPage";
import { mockColors, mockFonts } from "@/components/mock-shell/theme";
import { Spacer } from "@/components/ui";

const folders = ["Projects", "Documents", "Photos", "Downloads", "Shared", "Archive"];

export default function FilesScreen() {
  const router = useRouter();

  return (
    <MockPage title="Files" subtitle="Everything on solar-vale">
      <MockSearchField placeholder="Search files" />
      <Spacer size="2xl" />
      <View testID="files-section-heading" style={styles.sectionHeading}>
        <Text style={styles.sectionTitle}>Folders</Text>
        <Text style={styles.sectionMeta}>6 items</Text>
      </View>
      <Spacer size="md" />
      <GridTileGrid>
        {folders.map((folder) => (
          <GridTile
            key={folder}
            label={folder}
            icon={Folder01Icon}
            accessibilityLabel={`Open ${folder} folder`}
            onPress={() => router.push({ pathname: "/file-browser", params: { folder } } as never)}
          />
        ))}
      </GridTileGrid>
    </MockPage>
  );
}

const styles = StyleSheet.create({
  sectionHeading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
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
});
