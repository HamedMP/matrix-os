import { KeyboardAvoidingView, Platform, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";

import { Composer, type ComposerProps } from "@/components/chat/Composer";
import { ListRowSkeletonStack } from "@/components/shell/Controls";
import {
  BackIcon,
  Button,
  EmptyState,
  FolderIcon,
  IconTile,
  MoreIcon,
  SectionLabel,
  TopBar,
  TopBarButton,
} from "@/components/ui";
import { useKeyboardVisible } from "@/lib/use-keyboard-visible";

import { ProjectChatList, type ProjectChatListProps } from "./ProjectChatList";
import type { ProjectRow } from "./project-rows";

const BACK_ICON_SIZE = 22;

export interface ProjectScreenProps {
  /**
   * "loading": the projects are still being read. "error": they could not be
   * read. "missing": none of them has this id, as after it was archived.
   */
  state: "loading" | "error" | "missing" | "ready";
  /** The project, once `state` is "ready". */
  project: ProjectRow | null;
  chats: Omit<ProjectChatListProps, "header">;
  /** The composer starts a new chat in the project; this screen words its placeholder. */
  composer: Omit<ComposerProps, "keyboardOpen" | "placeholder">;
  onBack: () => void;
  onOpenOptions: () => void;
  /** Reads the projects again. */
  onRetry: () => void;
}

/** One project: its chats, and a composer that starts a new chat in it. It sits above the tab bar. */
export function ProjectScreen({ state, project, chats, composer, onBack, onOpenOptions, onRetry }: ProjectScreenProps) {
  const insets = useSafeAreaInsets();
  const keyboardOpen = useKeyboardVisible();
  const shown = state === "ready" ? project : null;
  const back = <TopBarButton icon={BackIcon} iconSize={BACK_ICON_SIZE} accessibilityLabel="Back" onPress={onBack} />;

  return (
    // As on the chat screen: the screen ends at the tab bar, so the keyboard's
    // overlap with it needs no offset.
    <KeyboardAvoidingView
      testID="project-screen"
      style={[styles.screen, { paddingTop: insets.top }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {shown ? (
        <>
          <TopBar
            testID="project-top-bar"
            title={shown.name}
            leading={back}
            trailing={<TopBarButton icon={MoreIcon} accessibilityLabel="Project options" onPress={onOpenOptions} />}
          />
          <ProjectChatList
            {...chats}
            header={(
              <View testID="project-intro" style={styles.intro}>
                <View testID="project-header" style={styles.header}>
                  <IconTile icon={FolderIcon} size={52} />
                  <View style={styles.headerText}>
                    <Text numberOfLines={2} style={styles.name}>{shown.name}</Text>
                    {shown.updated ? <Text numberOfLines={1} style={styles.updated}>{shown.updated}</Text> : null}
                  </View>
                </View>
                <SectionLabel>Chats</SectionLabel>
              </View>
            )}
          />
          <Composer {...composer} placeholder={`New chat in ${shown.name}`} keyboardOpen={keyboardOpen} />
        </>
      ) : (
        <>
          <TopBar testID="project-top-bar" leading={back} />
          {state === "loading" ? (
            <View testID="project-loading" style={styles.inset}>
              <ListRowSkeletonStack testID="project-skeleton-row" />
            </View>
          ) : state === "error" ? (
            <View style={[styles.inset, styles.notice]}>
              <Text accessibilityRole="alert" style={styles.noticeText}>Project could not be loaded.</Text>
              <Button variant="text" label="Try again" onPress={onRetry} />
            </View>
          ) : (
            <EmptyState icon={FolderIcon} message="Project not found" />
          )}
        </>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.v2.colors.background,
  },
  intro: {
    gap: theme.v2.space[18],
    paddingTop: theme.v2.space[12],
    paddingBottom: theme.v2.space[18],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[14],
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    ...theme.v2.text.heading,
    color: theme.v2.colors.textDefault,
  },
  updated: {
    ...theme.v2.text.caption,
    marginTop: theme.v2.space[2],
    color: theme.v2.colors.textSubtle,
  },
  inset: {
    paddingHorizontal: theme.v2.space[20],
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
