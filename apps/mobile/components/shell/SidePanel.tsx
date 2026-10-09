import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FlatList, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { CanonicalChatRecord } from "@matrix-os/contracts";

import { SearchField } from "@/components/shell/Controls";
import {
  SidePanelChatRow,
  SidePanelNavCount,
  SidePanelNavRow,
  SidePanelSkeletonRows,
} from "@/components/shell/SidePanelRows";
import { Button, CountBadge, FolderIcon, NewChatIcon, SectionLabel, SharedIcon, TopBarButton } from "@/components/ui";
import { groupSidePanelChats, searchSidePanelChats } from "@/lib/side-panel-chats";

const SEARCH_DEBOUNCE_MS = 300;
const NO_CHATS: readonly CanonicalChatRecord[] = [];

export interface SidePanelProps {
  /** The loaded chats, most recent activity first. */
  chats: readonly CanonicalChatRecord[];
  chatsLoading?: boolean;
  chatsFailed?: boolean;
  /** Left out until the projects have been read. */
  projectCount?: number;
  collaborationEnabled?: boolean;
  pendingInvitationCount?: number;
  /** The search being shown: the query last passed to `onSearchQueryChange`. */
  searchQuery?: string;
  /** Chats the server found for `searchQuery`. */
  searchResults?: readonly CanonicalChatRecord[];
  searching?: boolean;
  searchFailed?: boolean;
  loadingMore?: boolean;
  loadMoreFailed?: boolean;
  /** The time rows are dated against; the time of the render when omitted. */
  now?: Date;
  /** Called with the trimmed text once typing has stopped, and at once when the field is emptied. */
  onSearchQueryChange: (query: string) => void;
  /** Called when the list nears its end, and from "Try again" after a failure. */
  onLoadMore?: () => void;
  onNewChat: () => void;
  onSelectChat: (chatId: string) => void;
  onOpenProjects: () => void;
  onOpenShared: () => void;
}

/** The side panel of the Chats tab: new chat, search, projects, and the person's chats. */
export function SidePanel({
  chats,
  chatsLoading = false,
  chatsFailed = false,
  projectCount,
  collaborationEnabled = false,
  pendingInvitationCount = 0,
  searchQuery = "",
  searchResults = NO_CHATS,
  searching = false,
  searchFailed = false,
  loadingMore = false,
  loadMoreFailed = false,
  now,
  onSearchQueryChange,
  onLoadMore,
  onNewChat,
  onSelectChat,
  onOpenProjects,
  onOpenShared,
}: SidePanelProps) {
  const insets = useSafeAreaInsets();
  const { theme } = useUnistyles();
  const [searchText, setSearchText] = useState("");
  const pendingSearch = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (pendingSearch.current) clearTimeout(pendingSearch.current);
  }, []);

  function changeSearchText(text: string) {
    setSearchText(text);
    if (pendingSearch.current) clearTimeout(pendingSearch.current);
    pendingSearch.current = null;
    const query = text.trim();
    if (!query) {
      onSearchQueryChange("");
      return;
    }
    pendingSearch.current = setTimeout(() => {
      pendingSearch.current = null;
      onSearchQueryChange(query);
    }, SEARCH_DEBOUNCE_MS);
  }

  const searchShown = searchQuery !== "";
  const groups = useMemo(() => groupSidePanelChats(chats), [chats]);
  const rows = useMemo(
    () => (searchShown ? searchSidePanelChats(chats, searchQuery, searchResults) : groups.recent),
    [chats, groups, searchQuery, searchResults, searchShown],
  );
  const recentLabelShown = !searchShown && (chatsLoading || groups.recent.length > 0);

  let footer: ReactNode = null;
  if (searchShown) {
    if (searching) footer = <SidePanelSkeletonRows />;
    else if (searchFailed) footer = <Text accessibilityRole="alert" style={styles.note}>Search unavailable. Try again.</Text>;
    else if (rows.length === 0) footer = <Text style={styles.note}>No chats found</Text>;
  } else if (chatsLoading) {
    footer = <SidePanelSkeletonRows />;
  } else if (chats.length === 0) {
    footer = chatsFailed
      ? <Text accessibilityRole="alert" style={styles.note}>Chats unavailable. Try again.</Text>
      : <Text style={styles.note}>No chats yet</Text>;
  } else if (loadingMore) {
    footer = <SidePanelSkeletonRows />;
  } else if (loadMoreFailed) {
    footer = (
      <View style={styles.retry}>
        <Text accessibilityRole="alert" style={styles.note}>Older chats unavailable.</Text>
        <Button variant="text" label="Try again" onPress={onLoadMore} />
      </View>
    );
  }

  const sharedLabel = pendingInvitationCount > 0
    ? `Shared with me, ${pendingInvitationCount} pending ${pendingInvitationCount === 1 ? "invitation" : "invitations"}`
    : "Shared with me";

  return (
    <FlatList
      testID="side-panel"
      style={styles.panel}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + theme.v2.space[8] }]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      data={rows}
      keyExtractor={(record) => record.chat.id}
      renderItem={({ item }) => <SidePanelChatRow record={item} now={now} onSelect={onSelectChat} />}
      ItemSeparatorComponent={RowGap}
      onEndReached={searchShown || loadMoreFailed ? undefined : onLoadMore}
      onEndReachedThreshold={0.5}
      ListHeaderComponent={
        <View testID="side-panel-blocks" style={[styles.blocks, recentLabelShown ? styles.beforeRows : styles.beforeBlock]}>
          <View style={styles.titleRow}>
            <Text accessibilityRole="header" style={styles.title}>Chats</Text>
            <TopBarButton filled icon={NewChatIcon} accessibilityLabel="New chat" onPress={() => onNewChat()} />
          </View>
          <SearchField placeholder="Search chats" value={searchText} onChangeText={changeSearchText} />
          <SidePanelNavRow
            testID="side-panel-projects"
            icon={FolderIcon}
            label="Projects"
            accessibilityLabel={projectCount === undefined
              ? "Projects"
              : `Projects, ${projectCount} ${projectCount === 1 ? "project" : "projects"}`}
            detail={projectCount === undefined ? undefined : <SidePanelNavCount>{projectCount}</SidePanelNavCount>}
            onPress={onOpenProjects}
          />
          {collaborationEnabled ? (
            <SidePanelNavRow
              testID="side-panel-shared"
              icon={SharedIcon}
              label="Shared with me"
              accessibilityLabel={sharedLabel}
              detail={<CountBadge testID="side-panel-shared-badge" count={pendingInvitationCount} />}
              onPress={onOpenShared}
            />
          ) : null}
          {!searchShown && groups.needsYou.length > 0 ? (
            <View testID="side-panel-needs-you-group" style={styles.group}>
              <View testID="side-panel-needs-you" style={styles.groupHeader}>
                <SectionLabel>Needs you</SectionLabel>
                <CountBadge
                  count={groups.needsYou.length}
                  accessibilityLabel={`${groups.needsYou.length} ${groups.needsYou.length === 1 ? "chat" : "chats"}`}
                />
              </View>
              {groups.needsYou.map((record) => (
                <SidePanelChatRow key={record.chat.id} record={record} now={now} onSelect={onSelectChat} />
              ))}
            </View>
          ) : null}
          {recentLabelShown ? <SectionLabel>Recent</SectionLabel> : null}
        </View>
      }
      ListFooterComponent={footer ? <View style={rows.length > 0 && styles.afterRows}>{footer}</View> : null}
    />
  );
}

function RowGap() {
  return <View testID="side-panel-row-gap" style={styles.rowGap} />;
}

const styles = StyleSheet.create((theme) => ({
  panel: {
    flex: 1,
    backgroundColor: theme.v2.colors.background,
  },
  content: {
    paddingHorizontal: theme.v2.space[16],
    paddingBottom: theme.v2.space[24],
  },
  blocks: {
    gap: theme.v2.space[16],
  },
  // What follows the blocks: chat rows under the Recent label, or a block of its own.
  beforeRows: {
    marginBottom: theme.v2.space[4],
  },
  beforeBlock: {
    marginBottom: theme.v2.space[16],
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: {
    ...theme.v2.text.heading,
    color: theme.v2.colors.textDefault,
  },
  group: {
    gap: theme.v2.space[4],
  },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[6],
  },
  rowGap: {
    height: theme.v2.space[4],
  },
  afterRows: {
    marginTop: theme.v2.space[4],
  },
  note: {
    ...theme.v2.text.label,
    paddingVertical: theme.v2.space[10],
    color: theme.v2.colors.textSubtle,
    textAlign: "center",
  },
  retry: {
    alignItems: "center",
  },
}));
