import { ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";

import { GridTileSkeletonGrid, ListRowSkeletonStack } from "@/components/shell/Controls";
import { SidePanelSkeletonRows } from "@/components/shell/SidePanelRows";
import { Skeleton } from "@/components/ui";

import { PreviewCaption, PreviewSection } from "./PreviewSection";

/** Every placeholder the app shows while a list, a grid or a value loads. */
export function LoadingFrame() {
  const insets = useSafeAreaInsets();

  return (
    <ScrollView
      testID="design-preview-loading"
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
    >
      <PreviewSection title="List rows">
        <PreviewCaption>Agents, projects, templates, terminal sessions, connected apps</PreviewCaption>
        <ListRowSkeletonStack count={2} />
      </PreviewSection>
      <PreviewSection title="Grid tiles">
        <PreviewCaption>Apps and files</PreviewCaption>
        <GridTileSkeletonGrid />
      </PreviewSection>
      <PreviewSection title="Chat rows">
        <PreviewCaption>{"The side panel and a project's chats"}</PreviewCaption>
        <SidePanelSkeletonRows />
      </PreviewSection>
      <PreviewSection title="A single value">
        <PreviewCaption>The credit balance in the model sheet</PreviewCaption>
        <Skeleton testID="loading-frame-value" style={styles.value} />
      </PreviewSection>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.v2.colors.background,
  },
  content: {
    paddingHorizontal: theme.v2.space[20],
  },
  value: {
    width: theme.v2.size.tabItemWidth,
    height: theme.v2.text.labelMedium.fontSize,
    borderRadius: theme.v2.radius.tag,
  },
}));
