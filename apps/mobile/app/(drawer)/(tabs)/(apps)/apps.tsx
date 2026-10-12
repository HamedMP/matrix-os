import { useMemo, useState } from "react";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useRouter } from "expo-router";

import { AppLogo } from "@/components/apps/AppLogo";
import { DefaultAppIcon } from "@/components/apps/DefaultAppIcon";
import {
  GridTile,
  GridTileGrid,
  GridTileSkeletonGrid,
  SearchField,
} from "@/components/shell/Controls";
import { Page } from "@/components/shell/Page";
import { TabScreen } from "@/components/shell/TabScreen";
import { Spacer } from "@/components/ui";
import {
  buildLauncherEntries,
  filterLauncherEntries,
  launcherStatus,
  type DefaultAppDestination,
  type LauncherStatus,
} from "@/lib/apps-launcher";
import { useComputerApps, installedAppSlug } from "@/lib/queries/use-computer-apps";
import { buildAppIconUrl } from "@/lib/requests";
import { getAppSlug } from "@/lib/apps";
import { useShowChatScreen, useShowTab } from "@/lib/use-shell-navigation";

type InstalledApp = ReturnType<typeof useComputerApps>["apps"][number];

const STATUS_TEXT: Record<Exclude<LauncherStatus, "loading">, string> = {
  unavailable: "Apps unavailable. Try again.",
  "no-match": "No matching apps.",
  "none-installed": "No apps installed.",
};

export default function AppsTab() {
  return (
    <TabScreen>
      <AppsScreen />
    </TabScreen>
  );
}

function AppsScreen() {
  const [query, setQuery] = useState("");
  const { computer, apps, authorization, gatewayUrl, isPending, isError } = useComputerApps();
  const openDefaultApp = useOpenDefaultApp();
  const openInstalledApp = useOpenInstalledApp();
  // The default apps are screens of this app, so they stay listed while the
  // computer's own apps are loading or cannot be read.
  const loaded = !isPending && !isError;
  const entries = useMemo(() => buildLauncherEntries(loaded ? apps : []), [apps, loaded]);
  const visibleEntries = useMemo(() => filterLauncherEntries(entries, query), [entries, query]);
  const status = launcherStatus({
    isPending,
    isError,
    entries,
    visibleCount: visibleEntries.length,
    searching: query.trim().length > 0,
  });

  return (
    <Page title="Apps" subtitle={`Web apps on ${computer?.handle ?? "your computer"}`}>
      <SearchField placeholder="Search apps" value={query} onChangeText={setQuery} />
      <Spacer size="md" />
      <Text style={styles.statusText}>
        Apps that use workspace data or connected accounts may not work here yet. Open those apps on Web Canvas, Web Desktop or Electron Desktop.
      </Text>
      <Spacer size="xl" />
      <GridTileGrid>
        {visibleEntries.map((entry) => (entry.kind === "default" ? (
          <GridTile
            key={`default:${entry.id}`}
            label={entry.name}
            centered
            artworkLabelSpacerSize="md"
            leading={<DefaultAppIcon id={entry.id} name={entry.name} />}
            onPress={() => openDefaultApp(entry.destination)}
          />
        ) : (
          <GridTile
            key={installedAppSlug(entry.app)}
            label={entry.name}
            centered
            artworkLabelSpacerSize="md"
            leading={<AppLogo
              name={entry.name}
              uri={gatewayUrl ? buildAppIconUrl(gatewayUrl, entry.app.icon ?? entry.app.slug) : null}
              authorization={authorization}
            />}
            onPress={() => openInstalledApp(entry.app)}
          />
        )))}
      </GridTileGrid>
      {status ? <AppsStatus status={status} belowTiles={visibleEntries.length > 0} /> : null}
    </Page>
  );
}

function AppsStatus({ status, belowTiles }: { status: LauncherStatus; belowTiles: boolean }) {
  return (
    <>
      {belowTiles ? <Spacer size="md" /> : null}
      {status === "loading"
        ? <GridTileSkeletonGrid testID="app-tile-skeleton" />
        : <Text style={styles.statusText}>{STATUS_TEXT[status]}</Text>}
    </>
  );
}

function useOpenDefaultApp(): (destination: DefaultAppDestination) => void {
  const router = useRouter();
  const showChatScreen = useShowChatScreen();
  const showTab = useShowTab();
  return (destination) => {
    if (destination.kind === "screen") router.push(destination.href as never);
    else if (destination.tab === "chats") showChatScreen();
    else showTab(destination.tab);
  };
}

function useOpenInstalledApp(): (app: InstalledApp) => void {
  const router = useRouter();
  return (app) => router.push({
    pathname: "/app-preview/[app]",
    params: { app: installedAppSlug(app), runtimeSlug: getAppSlug(app), name: app.name },
  } as never);
}

const styles = StyleSheet.create((theme) => ({
  statusText: {
    fontFamily: theme.v2.fonts.body,
    fontSize: 14,
    color: theme.v2.appColors.muted,
  },
}));
