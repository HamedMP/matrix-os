import { StyleSheet, Text, View } from "react-native";
import { Stack, useRouter } from "expo-router";

import { GridTile } from "./MockControls";
import { mockColors, mockFonts } from "./theme";

const folderChildren: Record<string, string[]> = {
  Projects: ["matrix-os", "mobile-lab", "experiments"],
  "Projects/matrix-os": ["apps", "packages", "docs", "specs", "tests", "home"],
  "Projects/matrix-os/apps": ["mobile", "desktop", "site"],
};

export function FolderWorkspace({ segments }: { segments: string[] }) {
  const router = useRouter();
  const currentPath = segments.join("/");
  const title = segments.at(-1) ?? "Files";
  const children = folderChildren[currentPath] ?? ["Documents", "Images", "Archive"];

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title }} />
      <View style={styles.location}>
        <Text style={styles.eyebrow}>LOCATION</Text>
        <Text numberOfLines={1} style={styles.path}>{currentPath}</Text>
      </View>
      <View style={styles.grid}>
        {children.map((folder, index) => (
          <GridTile
            key={folder}
            label={folder}
            icon={index === 0 ? "folder-open-outline" : "folder-outline"}
            accent={index === 0}
            accessibilityLabel={`Open ${folder} folder`}
            onPress={() => router.push({
              pathname: "/file-browser/[...path]",
              params: { path: [...segments, folder] },
            } as never)}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 18,
    backgroundColor: mockColors.canvas,
  },
  location: {
    marginBottom: 18,
  },
  eyebrow: {
    fontFamily: mockFonts.semibold,
    fontSize: 10,
    letterSpacing: 1.1,
    color: mockColors.muted,
  },
  path: {
    marginTop: 5,
    fontFamily: mockFonts.mono,
    fontSize: 13,
    color: mockColors.ink,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
});
