import type { ReactElement } from "react";
import { FlatList, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { SidePanelSkeletonRows } from "@/components/shell/SidePanelRows";
import { Button, ChatIcon, EmptyState, IconTile, ItemRow } from "@/components/ui";

import type { ProjectChatRow } from "./project-rows";

export interface ProjectChatListProps {
  /** Drawn above the rows; scrolls away with them. */
  header: ReactElement;
  /** "error": the first page of chats could not be read. */
  state: "loading" | "error" | "ready";
  rows: readonly ProjectChatRow[];
  /** The server has chats beyond the ones loaded. */
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreFailed: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  /** Reads the first page again. */
  onRetry: () => void;
  onLoadMore: () => void;
  onOpenChat: (chatId: string) => void;
}

/** A project's chats, most recent first, a page at a time. */
export function ProjectChatList({
  header,
  state,
  rows,
  hasMore,
  loadingMore,
  loadMoreFailed,
  refreshing,
  onRefresh,
  onRetry,
  onLoadMore,
  onOpenChat,
}: ProjectChatListProps) {
  const ready = state === "ready";

  // What stands in for the rows. A page can come back empty while the server
  // still has more, and then it is the footer that offers them.
  let placeholder: ReactElement | null = null;
  if (state === "loading") {
    placeholder = <SidePanelSkeletonRows />;
  } else if (state === "error") {
    placeholder = <Notice text="Chats could not be loaded." onRetry={onRetry} />;
  } else if (!hasMore) {
    placeholder = (
      <View style={styles.empty}>
        <EmptyState icon={ChatIcon} message="No chats in this project yet" />
      </View>
    );
  }

  let footer: ReactElement | null = null;
  if (ready && loadingMore) {
    footer = <SidePanelSkeletonRows />;
  } else if (ready && loadMoreFailed) {
    footer = <Notice text="Older chats could not be loaded." onRetry={onLoadMore} />;
  } else if (ready && hasMore) {
    footer = (
      <View style={styles.notice}>
        <Button variant="text" label="Load more chats" onPress={onLoadMore} />
      </View>
    );
  }

  return (
    <FlatList
      testID="project-chats"
      style={styles.list}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      data={ready ? rows : []}
      keyExtractor={(row) => row.id}
      refreshing={refreshing}
      onRefresh={onRefresh}
      onEndReached={ready && hasMore && !loadingMore && !loadMoreFailed ? onLoadMore : undefined}
      onEndReachedThreshold={0.5}
      renderItem={({ item: row }) => (
        <ItemRow
          testID={`project-chat-${row.id}`}
          accessibilityLabel={[row.title, row.preview, row.time].filter(Boolean).join(", ")}
          density="compact"
          leading={<IconTile icon={ChatIcon} size={40} shape="circle" tone="subtle" />}
          title={row.title}
          subtitle={row.preview}
          meta={row.time}
          onPress={() => onOpenChat(row.id)}
        />
      )}
      ListHeaderComponent={header}
      ListEmptyComponent={placeholder}
      ListFooterComponent={footer}
    />
  );
}

function Notice({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <View style={styles.notice}>
      <Text accessibilityRole="alert" style={styles.noticeText}>{text}</Text>
      <Button variant="text" label="Try again" onPress={onRetry} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    flex: 1,
  },
  // Grows to the screen's height so the empty state has room to centre itself.
  content: {
    flexGrow: 1,
    paddingHorizontal: theme.v2.space[20],
    paddingBottom: theme.v2.space[20],
  },
  empty: {
    flex: 1,
  },
  notice: {
    alignItems: "center",
    gap: theme.v2.space[4],
  },
  noticeText: {
    ...theme.v2.text.label,
    color: theme.v2.colors.textSubtle,
    textAlign: "center",
  },
}));
