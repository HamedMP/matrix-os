import { StyleSheet, View } from "react-native";
import { Stack, useRouter } from "expo-router";
import Folder01Icon from "@hugeicons/core-free-icons/Folder01Icon";

import { Spacer } from "@/components/ui";
import { GridTile, GridTileGrid } from "./MockControls";
import { mockColors } from "./theme";

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
      <Spacer size="lg" />
      <GridTileGrid>
        {children.map((folder) => (
          <GridTile
            key={folder}
            label={folder}
            icon={Folder01Icon}
            accessibilityLabel={`Open ${folder} folder`}
            onPress={() => router.push({
              pathname: "/file-browser/[...path]",
              params: { path: [...segments, folder] },
            } as never)}
          />
        ))}
      </GridTileGrid>
      <Spacer size="3xl" />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    paddingHorizontal: 20,
    backgroundColor: mockColors.canvas,
  },
});
