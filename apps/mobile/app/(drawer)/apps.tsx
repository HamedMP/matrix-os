import { useMemo, useState } from "react";
import { StyleSheet, Text } from "react-native";
import { useRouter } from "expo-router";

import { AppLogo } from "@/components/apps/AppLogo";
import {
  GridTile,
  GridTileGrid,
  GridTileSkeletonGrid,
  MockSearchField,
} from "@/components/mock-shell/MockControls";
import { MockPage } from "@/components/mock-shell/MockPage";
import { mockColors, mockFonts } from "@/components/mock-shell/theme";
import { Spacer } from "@/components/ui";
import { useComputerApps, installedAppSlug } from "@/lib/queries/use-computer-apps";
import { buildAppIconUrl } from "@/lib/requests";

export default function AppsScreen() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const { computer, apps, authorization, gatewayUrl, isPending, isError } = useComputerApps();
  const visibleApps = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return apps;
    return apps.filter((app) => app.name.toLocaleLowerCase().includes(normalizedQuery));
  }, [apps, query]);

  return (
    <MockPage title="Apps" subtitle={`Experiences installed on ${computer?.handle ?? "your computer"}`}>
      <MockSearchField placeholder="Search apps" value={query} onChangeText={setQuery} />
      <Spacer size="xl" />
      {isPending ? <GridTileSkeletonGrid testID="app-tile-skeleton" /> : null}
      {isError ? <Text style={styles.statusText}>Apps unavailable. Try again.</Text> : null}
      {!isPending && !isError && visibleApps.length === 0 ? (
        <Text style={styles.statusText}>{query.trim() ? "No matching apps." : "No apps installed."}</Text>
      ) : null}
      {!isPending && !isError && visibleApps.length > 0 ? (
        <GridTileGrid>
          {visibleApps.map((app) => {
            const slug = installedAppSlug(app);
            return (
              <GridTile
                key={slug}
                label={app.name}
                centered
                artworkLabelSpacerSize="md"
                leading={<AppLogo
                  name={app.name}
                  uri={gatewayUrl ? buildAppIconUrl(gatewayUrl, app.icon ?? app.slug) : null}
                  authorization={authorization}
                />}
                onPress={() => router.push({
                  pathname: "/app-preview/[app]",
                  params: { app: slug, name: app.name },
                } as never)}
              />
            );
          })}
        </GridTileGrid>
      ) : null}
    </MockPage>
  );
}

const styles = StyleSheet.create({
  statusText: {
    fontFamily: mockFonts.body,
    fontSize: 14,
    color: mockColors.muted,
  },
});
