import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text as NativeText,
  View,
} from "react-native";
import { Image } from "expo-image";
import FileEmpty01Icon from "@hugeicons/core-free-icons/FileEmpty01Icon";

import { AnalyticsMask } from "@/lib/analytics";
import { useComputerFilePreview } from "@/lib/queries/use-computer-file-preview";
import { mockColors, mockFonts } from "@/components/mock-shell/theme";
import { EmptyState, Spacer, Text } from "@/components/ui";
import { usePullToRefresh } from "@/lib/use-pull-to-refresh";

export function ComputerFilePreview({ name, path }: { name: string; path: string }) {
  const { preview, isPending, isError, refresh } = useComputerFilePreview(path);
  const pullToRefresh = usePullToRefresh(refresh);
  const isImage = preview?.kind === "image";
  const isTextWithContent = preview?.kind === "text" && preview.content.length > 0;

  return (
    <AnalyticsMask testID="file-preview-screen" style={styles.screen}>
      <ScrollView
        style={styles.viewport}
        contentContainerStyle={[
          styles.content,
          isImage ? styles.imageContent : null,
          isTextWithContent ? styles.textContent : null,
        ]}
        alwaysBounceVertical
        maximumZoomScale={isImage ? 4 : 1}
        minimumZoomScale={1}
        refreshControl={(
          <RefreshControl
            testID="file-preview-refresh-control"
            refreshing={pullToRefresh.refreshing}
            onRefresh={pullToRefresh.onRefresh}
            tintColor={mockColors.ink}
            colors={[mockColors.ink]}
            progressBackgroundColor={mockColors.canvas}
          />
        )}
      >
        {isPending ? (
          <View style={styles.centered}>
            <ActivityIndicator color={mockColors.ink} />
            <Spacer size="md" />
            <Text size="muted" tone="subtle">Loading preview…</Text>
          </View>
        ) : null}

        {isError ? (
          <View style={styles.centered}>
            <Text size="body" align="center">Preview unavailable.</Text>
            <Spacer size="sm" />
            <Text size="muted" tone="subtle" align="center">Try opening the file again.</Text>
          </View>
        ) : null}

        {preview?.kind === "unpreviewable" ? (
          <View style={styles.centered}>
            <Text size="body" align="center">
              {preview.reason === "too-large"
                ? "This file is too large to preview."
                : preview.reason === "binary"
                  ? "This binary file cannot be previewed."
                  : "This file cannot be previewed safely."}
            </Text>
          </View>
        ) : null}

        {preview?.kind === "image" ? (
          <>
            <Spacer size="lg" />
            <Image
              accessibilityLabel={name}
              source={{
                uri: preview.uri,
                headers: { Authorization: preview.authorization },
              }}
              contentFit="contain"
              style={styles.image}
            />
            <Spacer size="3xl" />
          </>
        ) : null}

        {preview?.kind === "text" && preview.content.length === 0 ? (
          <EmptyState
            icon={FileEmpty01Icon}
            message="this file is currently empty"
            testID="empty-file-state"
            iconTestID="empty-file-icon"
          />
        ) : null}

        {preview?.kind === "text" && preview.content.length > 0 ? (
          <>
            <Spacer size="lg" />
            <ScrollView horizontal showsHorizontalScrollIndicator>
              <NativeText testID="file-preview-text" selectable style={styles.code}>
                {preview.content}
              </NativeText>
            </ScrollView>
            <Spacer size="3xl" />
          </>
        ) : null}
      </ScrollView>
    </AnalyticsMask>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: mockColors.canvas,
  },
  viewport: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  imageContent: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  image: {
    width: "100%",
    height: 420,
  },
  textContent: {
    paddingHorizontal: 16,
  },
  code: {
    fontFamily: mockFonts.mono,
    fontSize: 12,
    lineHeight: 18,
    color: mockColors.ink,
  },
});
