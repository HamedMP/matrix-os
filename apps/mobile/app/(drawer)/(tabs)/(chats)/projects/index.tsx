import { useMemo, useRef, useState } from "react";
import { Alert } from "react-native";
import { useRouter } from "expo-router";

import { ProjectNameSheet } from "@/components/projects/ProjectNameSheet";
import { ProjectsListScreen } from "@/components/projects/ProjectsListScreen";
import { confirmArchiveProject } from "@/components/projects/project-archive";
import { ARCHIVE_FAILED_TITLE, archiveFailureMessage, projectNameFailure } from "@/components/projects/project-failures";
import { projectRows } from "@/components/projects/project-rows";
import { useBackOr } from "@/components/projects/use-back-or";
import { useProjectList } from "@/components/projects/use-project-list";
import { useArchiveProject, useCreateProject, useRenameProject } from "@/lib/queries/use-project-mutations";
import { canonicalChatRequestId } from "@/lib/requests/canonical-chat";
import type { ProjectSummary } from "@/lib/requests/projects";
import { showToast } from "@/lib/toast";

export default function ProjectsRoute() {
  const router = useRouter();
  const list = useProjectList();
  const create = useCreateProject();
  const rename = useRenameProject();
  const archive = useArchiveProject();
  // The project the name sheet renames, or null when it creates one. Kept as
  // the sheet closes, so it slides away showing what it showed.
  const [renaming, setRenaming] = useState<ProjectSummary | null>(null);
  const goBack = useBackOr("/(drawer)");
  const [query, setQuery] = useState("");
  const [naming, setNaming] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // A name tried again goes out under the request id of its first attempt, so
  // an attempt that reached the server answers with the project it made
  // instead of calling the name taken.
  const attempt = useRef<{ name: string; requestId: string } | null>(null);

  const rows = useMemo(() => projectRows(list.projects, query), [list.projects, query]);

  const openProject = (projectId: string) => {
    router.push({ pathname: "/projects/[projectId]", params: { projectId } } as never);
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await list.reload();
    } finally {
      setRefreshing(false);
    }
  };

  const projectById = (projectId: string) => list.projects.find((project) => project.id === projectId) ?? null;

  const startRenaming = (projectId: string) => {
    const project = projectById(projectId);
    if (!project) return;
    rename.reset();
    setRenaming(project);
    setNaming(true);
  };

  const renameProject = (name: string) => {
    if (!renaming) return;
    rename.mutate({ slug: renaming.slug, name }, {
      onSuccess: () => {
        setNaming(false);
        showToast("Project renamed");
      },
    });
  };

  const archiveProject = (projectId: string) => {
    const project = projectById(projectId);
    if (!project) return;
    confirmArchiveProject(project.name, () => {
      archive.mutate(project.slug, {
        onSuccess: () => showToast("Project archived"),
        onError: (error: unknown) => Alert.alert(ARCHIVE_FAILED_TITLE, archiveFailureMessage(error)),
      });
    });
  };

  const startNaming = () => {
    create.reset();
    setRenaming(null);
    setNaming(true);
  };

  const createProject = (name: string) => {
    if (attempt.current?.name !== name) attempt.current = { name, requestId: canonicalChatRequestId() };
    create.mutate({ name, clientRequestId: attempt.current.requestId }, {
      onSuccess: (project) => {
        attempt.current = null;
        setNaming(false);
        openProject(project.id);
      },
    });
  };

  return (
    <>
      <ProjectsListScreen
        state={list.state}
        rows={rows}
        query={query}
        onChangeQuery={setQuery}
        refreshing={refreshing}
        onRefresh={() => void refresh()}
        onRetry={() => void list.reload()}
        onBack={goBack}
        onNewProject={startNaming}
        onOpenProject={openProject}
        onRenameProject={startRenaming}
        onArchiveProject={archiveProject}
      />

      {/* One sheet names a new project or renames one: a second sheet cannot open while the first is on its way out. */}
      <ProjectNameSheet
        visible={naming}
        title={renaming ? "Rename project" : "New project"}
        confirmLabel={renaming ? "Save" : "Create"}
        initialName={renaming?.name}
        saving={renaming ? rename.isPending : create.isPending}
        failure={renaming
          ? rename.isError ? projectNameFailure(rename.error, "Project could not be renamed. Try again.") : null
          : create.isError ? projectNameFailure(create.error, "Project could not be created. Try again.") : null}
        onSubmit={renaming ? renameProject : createProject}
        onCancel={() => setNaming(false)}
      />
    </>
  );
}
