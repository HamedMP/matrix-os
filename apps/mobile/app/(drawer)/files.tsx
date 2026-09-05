import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useRouter } from "expo-router";
import File01Icon from "@hugeicons/core-free-icons/File01Icon";
import Folder01Icon from "@hugeicons/core-free-icons/Folder01Icon";

import { EmptyFolderState } from "@/components/files/EmptyFolderState";
import { FileCreationControls } from "@/components/files/FileCreationControls";
import {
  FileTileSkeletonGrid,
  GridTile,
  GridTileGrid,
  MockSearchField,
} from "@/components/mock-shell/MockControls";
import { MockPage } from "@/components/mock-shell/MockPage";
import { Spacer } from "@/components/ui";
import { useComputerDirectory } from "@/lib/queries/use-computer-directory";
import { usePullToRefresh } from "@/lib/use-pull-to-refresh";

export default function FilesScreen() {
  const router = useRouter();
  const { computer, entries, isPending, isError, refresh } = useComputerDirectory("");
  const pullToRefresh = usePullToRefresh(refresh);
  const sectionMeta = isPending
    ? "Loading…"
    : isError
      ? "Unavailable"
      : `${entries.length} ${entries.length === 1 ? "item" : "items"}`;

  return (
    <View style={styles.screen}>
      <MockPage
        title="Files"
        subtitle={`Everything on ${computer?.handle ?? "your computer"}`}
        refreshing={pullToRefresh.refreshing}
        onRefresh={pullToRefresh.onRefresh}
      >
        <MockSearchField placeholder="Search files" />
        <Spacer size="2xl" />
        <View testID="files-section-heading" style={styles.sectionHeading}>
          <Text style={styles.sectionTitle}>Items</Text>
          <Text style={styles.sectionMeta}>{sectionMeta}</Text>
        </View>
        <Spacer size="md" />
        {isPending ? <FileTileSkeletonGrid /> : null}
        {isError ? <Text style={styles.statusText}>Files unavailable. Try again.</Text> : null}
        {!isPending && !isError && entries.length === 0 ? <EmptyFolderState /> : null}
        {!isPending && !isError && entries.length > 0 ? (
          <GridTileGrid>
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
                    pathname: "/file-browser",
                    params: { folder: entry.name },
                  } as never)
                  : () => router.push({
                    pathname: "/file-browser/file",
                    params: { name: entry.name, path: entry.name },
                  } as never)}
              />
            ))}
          </GridTileGrid>
        ) : null}
      </MockPage>
      <FileCreationControls currentPath="" />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
  },
  sectionHeading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionTitle: {
    fontFamily: theme.v2.fonts.semibold,
    fontSize: 14,
    color: theme.v2.appColors.ink,
  },
  sectionMeta: {
    fontFamily: theme.v2.fonts.body,
    fontSize: 12,
    color: theme.v2.appColors.muted,
  },
  statusText: {
    fontFamily: theme.v2.fonts.body,
    fontSize: 14,
    color: theme.v2.appColors.muted,
  },
}));
