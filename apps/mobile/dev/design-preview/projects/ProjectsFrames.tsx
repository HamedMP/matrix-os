import { useState, type ReactNode } from "react";
import { Platform, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { ModelTrigger } from "@/components/chat/ModelTrigger";
import { ProjectNameSheet } from "@/components/projects/ProjectNameSheet";
import { ProjectOptionsSheet, type ProjectOptionsPage } from "@/components/projects/ProjectOptionsSheet";
import { ProjectScreen } from "@/components/projects/ProjectScreen";
import { ProjectsListScreen } from "@/components/projects/ProjectsListScreen";
import { projectChatRows, projectRow, projectRows } from "@/components/projects/project-rows";
import { TabBar } from "@/components/shell/TabBar";
import { useKeyboardVisible } from "@/lib/use-keyboard-visible";

import {
  SAMPLE_MODEL,
  SAMPLE_NOW,
  SAMPLE_PROJECT,
  SAMPLE_PROJECT_CHATS,
  SAMPLE_PROJECTS,
  SAMPLE_WAITING_COUNT,
} from "./sample";

function noop() {}

/** Frame P1: the projects list above the tab bar. */
export function ProjectsListFrame() {
  return <ProjectsFrame naming={false} />;
}

/** Frame P1b: the new project sheet open over the list. */
export function NewProjectFrame() {
  return <ProjectsFrame naming />;
}

/** Frame P2: a project with its chats and composer, above the tab bar. */
export function ProjectFrame() {
  return <OpenProjectFrame page={null} />;
}

/** Frame P3: the project's menu open over it. */
export function ProjectMenuFrame() {
  return <OpenProjectFrame page="menu" />;
}

/** Frame P4: the rename sheet open over the project. */
export function RenameProjectFrame() {
  return <OpenProjectFrame page="rename" />;
}

function ProjectsFrame({ naming: namingAtFirst }: { naming: boolean }) {
  const [query, setQuery] = useState("");
  const [naming, setNaming] = useState(namingAtFirst);

  return (
    <AboveTabBar
      sheet={(
        <ProjectNameSheet
          visible={naming}
          title="New project"
          confirmLabel="Create"
          saving={false}
          onSubmit={noop}
          onCancel={() => setNaming(false)}
        />
      )}
    >
      <ProjectsListScreen
        state="ready"
        rows={projectRows(SAMPLE_PROJECTS, query, SAMPLE_NOW)}
        query={query}
        onChangeQuery={setQuery}
        refreshing={false}
        onRefresh={noop}
        onRetry={noop}
        onBack={noop}
        onNewProject={() => setNaming(true)}
        onOpenProject={noop}
      />
    </AboveTabBar>
  );
}

function OpenProjectFrame({ page: pageAtFirst }: { page: ProjectOptionsPage | null }) {
  const [page, setPage] = useState(pageAtFirst);
  const [draft, setDraft] = useState("");
  const project = projectRow(SAMPLE_PROJECT, SAMPLE_NOW);

  return (
    <AboveTabBar
      sheet={(
        <ProjectOptionsSheet
          page={page}
          name={project.name}
          updated={project.updated}
          archiving={false}
          renaming={false}
          onRename={() => setPage("rename")}
          onArchive={noop}
          onSubmitName={noop}
          onClose={() => setPage(null)}
        />
      )}
    >
      <ProjectScreen
        state="ready"
        project={project}
        chats={{
          state: "ready",
          rows: projectChatRows(SAMPLE_PROJECT_CHATS, SAMPLE_NOW),
          hasMore: false,
          loadingMore: false,
          loadMoreFailed: false,
          refreshing: false,
          onRefresh: noop,
          onRetry: noop,
          onLoadMore: noop,
          onOpenChat: noop,
        }}
        composer={{
          draft,
          onChangeDraft: setDraft,
          canSend: draft.trim().length > 0,
          onSend: noop,
          modelControl: <ModelTrigger {...SAMPLE_MODEL} onPress={noop} />,
        }}
        onBack={noop}
        onOpenOptions={() => setPage("menu")}
        onRetry={noop}
      />
    </AboveTabBar>
  );
}

/** A screen of the Chats tab over the app's tab bar, with two agents waiting, and the sheet that opens over both. */
function AboveTabBar({ children, sheet }: { children: ReactNode; sheet: ReactNode }) {
  const keyboardVisible = useKeyboardVisible();

  return (
    <View style={styles.frame}>
      {children}
      {/* As in the tabs layout: Android lifts the bar onto the keyboard, so it is hidden there. */}
      {Platform.OS === "android" && keyboardVisible ? null : (
        <TabBar activeRoute="(chats)" agentsBadgeCount={SAMPLE_WAITING_COUNT} onTabPress={noop} />
      )}
      {sheet}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  frame: {
    flex: 1,
    backgroundColor: theme.v2.colors.background,
  },
}));
