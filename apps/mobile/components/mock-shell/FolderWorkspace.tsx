import { ScrollView, StyleSheet, Text } from "react-native";
import { Stack, useRouter } from "expo-router";
import File01Icon from "@hugeicons/core-free-icons/File01Icon";
import Folder01Icon from "@hugeicons/core-free-icons/Folder01Icon";

import { Spacer } from "@/components/ui";
import { FileTileSkeletonGrid, GridTile, GridTileGrid } from "./MockControls";
import { mockColors, mockFonts } from "./theme";
import { useComputerDirectory } from "@/lib/queries/use-computer-directory";

export function FolderWorkspace({ segments }: { segments: string[] }) {
  const router = useRouter();
  const currentPath = segments.join("/");
  const title = segments.at(-1) ?? "Files";
  const { entries, isPending, isError } = useComputerDirectory(currentPath);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title }} />
      <Spacer size="lg" />
      {isPending ? <FileTileSkeletonGrid /> : null}
      {isError ? <Text style={styles.statusText}>Files unavailable. Try again.</Text> : null}
      {!isPending && !isError ? <GridTileGrid>
        {entries.map((entry) => (
          <GridTile
            key={entry.name}
            label={entry.name}
            icon={entry.type === "directory" ? Folder01Icon : File01Icon}
            accessibilityLabel={entry.type === "directory"
              ? `Open ${entry.name} folder`
              : `Open ${entry.name} file`}
            onPress={entry.type === "directory"
              ? () => router.push({
                  pathname: "/file-browser/[...path]",
                  params: { path: [...segments, entry.name] },
                } as never)
              : () => router.push({
                  pathname: "/file-browser/file",
                  params: {
                    name: entry.name,
                    path: currentPath ? `${currentPath}/${entry.name}` : entry.name,
                  },
                } as never)}
          />
        ))}
      </GridTileGrid> : null}
      <Spacer size="3xl" />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: mockColors.canvas,
  },
  content: {
    flexGrow: 1,
    paddingHorizontal: 20,
  },
  statusText: {
    fontFamily: mockFonts.body,
    fontSize: 14,
    color: mockColors.muted,
  },
});
