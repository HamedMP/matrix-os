import type { CanonicalChatModelSelection } from "@matrix-os/contracts";
import { useMemo, useState } from "react";
import { Alert } from "react-native";
import { useLocalSearchParams, useNavigation } from "expo-router";

import { ModelPicker } from "@/components/ModelPicker";
import { ProjectOptionsSheet, type ProjectOptionsPage } from "@/components/projects/ProjectOptionsSheet";
import { ProjectScreen } from "@/components/projects/ProjectScreen";
import { ARCHIVE_FAILED_TITLE, archiveFailureMessage, projectNameFailure } from "@/components/projects/project-failures";
import { projectChatRows, projectRow } from "@/components/projects/project-rows";
import { useBackOr } from "@/components/projects/use-back-or";
import { useProjectComposer } from "@/components/projects/use-project-composer";
import { useProjectList } from "@/components/projects/use-project-list";
import { useCanonicalChatSession } from "@/lib/canonical-chat-session-context";
import { defaultCatalogSelection, defaultTurnModes } from "@/lib/canonical-chat-selection";
import { useChatProviderCatalog } from "@/lib/queries/use-chat-provider-catalog";
import { useProjectChats } from "@/lib/queries/use-project-chats";
import { useArchiveProject, useRenameProject } from "@/lib/queries/use-project-mutations";
import type { ProjectSummary } from "@/lib/requests/projects";
import { useSessionTokenWarmup } from "@/lib/use-session-token-warmup";
import { useShowChatScreen } from "@/lib/use-shell-navigation";

export default function ProjectRoute() {
  const params = useLocalSearchParams<{ projectId?: string | string[] }>();
  const projectId = typeof params.projectId === "string" ? params.projectId : null;
  const navigation = useNavigation();
  const goBack = useBackOr("/projects");
  const showChatScreen = useShowChatScreen();
  const warmSessionToken = useSessionTokenWarmup();
  const { selectChat, setSelectionOverride } = useCanonicalChatSession();
  const list = useProjectList();
  const rename = useRenameProject();
  const archive = useArchiveProject();
  const { catalog, isPending: catalogPending, isFetching: catalogFetching } = useChatProviderCatalog();
  const [page, setPage] = useState<ProjectOptionsPage | null>(null);
  // The project being archived: it stays on screen once the list has dropped
  // it, until this screen has gone back.
  const [leaving, setLeaving] = useState<ProjectSummary | null>(null);
  // The model chosen here belongs to the chat this composer will start, not
  // to whichever chat is open on the chat screen.
  const [chosenModel, setChosenModel] = useState<CanonicalChatModelSelection | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const project = list.projects.find((candidate) => candidate.id === projectId) ?? leaving;
  const chats = useProjectChats(project?.id ?? null);
  const shown = useMemo(() => (project ? projectRow(project) : null), [project]);
  const chatRows = useMemo(() => projectChatRows(chats.chats), [chats.chats]);

  const selection = chosenModel ?? defaultCatalogSelection(catalog);
  const composer = useProjectComposer({
    projectId: project?.id ?? null,
    selection,
    turnModes: defaultTurnModes(catalog, selection),
    // There is no model to send to until the provider catalog has loaded.
    disabled: catalogPending,
    onChatStarted: (_chatId, startedWith) => {
      // The send made the new chat the one on the chat screen. The model it
      // was started with stays chosen there.
      setSelectionOverride(startedWith);
      if (navigation.isFocused()) showChatScreen();
    },
  });

  const reload = async () => {
    try {
      await Promise.all([list.reload(), project ? chats.refetch() : null]);
    } catch (error: unknown) {
      console.warn("[mobile] project reload failed", error instanceof Error ? error.name : "unknown");
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await reload();
    } finally {
      setRefreshing(false);
    }
  };

  const archiveProject = (target: ProjectSummary) => {
    setLeaving(target);
    archive.mutate(target.slug, {
      onSuccess: () => {
        setPage(null);
        goBack();
      },
      onError: (error: unknown) => {
        setLeaving(null);
        Alert.alert(ARCHIVE_FAILED_TITLE, archiveFailureMessage(error));
      },
    });
  };

  const confirmArchive = () => {
    if (!project) return;
    Alert.alert(`Archive ${project.name}?`, "It leaves your project list. Its chats are kept.", [
      { text: "Cancel", style: "cancel" },
      { text: "Archive", onPress: () => archiveProject(project) },
    ]);
  };

  return (
    <>
      <ProjectScreen
        state={project ? "ready" : list.state === "ready" ? "missing" : list.state}
        project={shown}
        chats={{
          state: chats.isPending ? "loading" : chats.isError && chats.chats.length === 0 ? "error" : "ready",
          rows: chatRows,
          hasMore: chats.hasMore,
          loadingMore: chats.isLoadingMore,
          loadMoreFailed: chats.isLoadMoreError,
          refreshing,
          onRefresh: () => void refresh(),
          onRetry: () => void reload(),
          onLoadMore: () => {
            if (chats.hasMore && !chats.isLoadingMore) void chats.loadMore();
          },
          onOpenChat: (chatId) => {
            selectChat(chatId);
            showChatScreen();
          },
        }}
        composer={{
          draft: composer.draft,
          onChangeDraft: (text) => {
            composer.setDraft(text);
            warmSessionToken();
          },
          onFocus: warmSessionToken,
          canSend: composer.canSend,
          onSend: composer.send,
          running: composer.isSending,
          modelControl: (
            <ModelPicker
              catalog={catalog}
              catalogLoading={catalogPending || catalogFetching}
              selection={selection}
              onSelectionChange={setChosenModel}
            />
          ),
        }}
        onBack={goBack}
        onOpenOptions={() => setPage("menu")}
        onRetry={() => void list.reload()}
      />
      {shown && project ? (
        <ProjectOptionsSheet
          page={page}
          name={shown.name}
          updated={shown.updated}
          archiving={archive.isPending}
          renaming={rename.isPending}
          renameFailure={rename.isError ? projectNameFailure(rename.error, "Project could not be renamed. Try again.") : null}
          onRename={() => {
            rename.reset();
            setPage("rename");
          }}
          onArchive={confirmArchive}
          onSubmitName={(name) => rename.mutate({ slug: project.slug, name }, { onSuccess: () => setPage(null) })}
          onClose={() => setPage(null)}
        />
      ) : null}
    </>
  );
}
