import { RefreshControl, ScrollView, Text } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Stack, useRouter } from "expo-router";
import File01Icon from "@hugeicons/core-free-icons/File01Icon";
import Folder01Icon from "@hugeicons/core-free-icons/Folder01Icon";

import { EmptyFolderState } from "@/components/files/EmptyFolderState";
import { Spacer } from "@/components/ui";
import { FileTileSkeletonGrid, GridTile, GridTileGrid } from "./MockControls";
import { useComputerDirectory } from "@/lib/queries/use-computer-directory";
import { usePullToRefresh } from "@/lib/use-pull-to-refresh";

export function FolderWorkspace({ segments }: { segments: string[] }) {
  const router = useRouter();
  const { theme } = useUnistyles();
  const currentPath = segments.join("/");
  const title = segments.at(-1) ?? "Files";
  const { entries, isPending, isError, refresh } = useComputerDirectory(currentPath);
  const pullToRefresh = usePullToRefresh(refresh);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      alwaysBounceVertical
      refreshControl={(
        <RefreshControl
          testID="file-browser-refresh-control"
          refreshing={pullToRefresh.refreshing}
          onRefresh={pullToRefresh.onRefresh}
          tintColor={theme.v2.appColors.ink}
          colors={[theme.v2.appColors.ink]}
          progressBackgroundColor={theme.v2.appColors.canvas}
        />
      )}
    >
      <Stack.Screen options={{ title }} />
      <Spacer size="lg" />
      {isPending ? <FileTileSkeletonGrid /> : null}
      {isError ? <Text style={styles.statusText}>Files unavailable. Try again.</Text> : null}
      {!isPending && !isError && entries.length === 0 ? <EmptyFolderState /> : null}
      {!isPending && !isError && entries.length > 0 ? <GridTileGrid>
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

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.v2.appColors.canvas,
  },
  content: {
    flexGrow: 1,
    paddingHorizontal: 20,
  },
  statusText: {
    fontFamily: theme.v2.fonts.body,
    fontSize: 14,
    color: theme.v2.appColors.muted,
  },
}));
