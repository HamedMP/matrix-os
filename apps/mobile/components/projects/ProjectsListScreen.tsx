import { FlatList, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { ListRowSkeletonStack, SearchField } from "@/components/shell/Controls";
import { TabScreen } from "@/components/shell/TabScreen";
import {
  AddIcon,
  BackIcon,
  Button,
  ChevronRightIcon,
  EmptyState,
  FolderIcon,
  Icon,
  IconTile,
  ItemRow,
  TopBar,
  TopBarButton,
} from "@/components/ui";

import type { ProjectRow } from "./project-rows";

const BACK_ICON_SIZE = 22;
const CHEVRON_SIZE = 18;

export interface ProjectsListScreenProps {
  /** "error": the projects could not be read and there are none to show. */
  state: "loading" | "error" | "ready";
  /** The projects to list: those matching `query`. */
  rows: readonly ProjectRow[];
  query: string;
  onChangeQuery: (query: string) => void;
  refreshing: boolean;
  onRefresh: () => void;
  onRetry: () => void;
  onBack: () => void;
  onNewProject: () => void;
  onOpenProject: (projectId: string) => void;
}

/** Every project, opened from the side panel of the Chats tab. */
export function ProjectsListScreen({
  state,
  rows,
  query,
  onChangeQuery,
  refreshing,
  onRefresh,
  onRetry,
  onBack,
  onNewProject,
  onOpenProject,
}: ProjectsListScreenProps) {
  const { theme } = useUnistyles();

  return (
    <TabScreen testID="projects-screen">
      <TopBar
        testID="projects-top-bar"
        leading={(
          <TopBarButton icon={BackIcon} iconSize={BACK_ICON_SIZE} accessibilityLabel="Back" onPress={onBack} />
        )}
        trailing={<Button variant="secondary" icon={AddIcon} label="New project" onPress={onNewProject} />}
      />
      <View testID="projects-body" style={styles.body}>
        <Text accessibilityRole="header" style={styles.title}>Projects</Text>
        <SearchField placeholder="Search projects" value={query} onChangeText={onChangeQuery} />
        {state === "loading" ? (
          <ListRowSkeletonStack testID="project-skeleton-row" />
        ) : state === "error" ? (
          <View testID="projects-error" style={styles.notice}>
            <Text accessibilityRole="alert" style={styles.noticeText}>Projects could not be loaded.</Text>
            <Button variant="text" label="Try again" onPress={onRetry} />
          </View>
        ) : (
          <FlatList
            testID="projects-list"
            data={rows}
            keyExtractor={(row) => row.id}
            refreshing={refreshing}
            onRefresh={onRefresh}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            contentContainerStyle={styles.list}
            renderItem={({ item: row }) => (
              <ItemRow
                testID={`project-row-${row.id}`}
                accessibilityLabel={[row.name, row.updated].filter(Boolean).join(", ")}
                density="comfortable"
                gap={14}
                leading={<IconTile icon={FolderIcon} size={44} />}
                title={row.name}
                subtitle={row.updated}
                trailing={<Icon icon={ChevronRightIcon} size={CHEVRON_SIZE} color={theme.v2.colors.textSubtle} />}
                onPress={() => onOpenProject(row.id)}
              />
            )}
            ListEmptyComponent={query.trim() ? (
              <Text style={styles.noticeText}>No projects match that search.</Text>
            ) : (
              <View testID="projects-empty" style={styles.empty}>
                <EmptyState icon={FolderIcon} message="No projects yet" />
                <Button fullWidth icon={AddIcon} label="New project" onPress={onNewProject} />
              </View>
            )}
          />
        )}
      </View>
    </TabScreen>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    flex: 1,
    gap: theme.v2.space[16],
    paddingTop: theme.v2.space[6],
    paddingHorizontal: theme.v2.space[20],
  },
  title: {
    ...theme.v2.text.title,
    color: theme.v2.colors.textDefault,
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
  // Grows to the screen's height so the empty state has room to centre itself.
  list: {
    flexGrow: 1,
    paddingBottom: theme.v2.space[20],
  },
  empty: {
    flex: 1,
    gap: theme.v2.space[16],
  },
}));
