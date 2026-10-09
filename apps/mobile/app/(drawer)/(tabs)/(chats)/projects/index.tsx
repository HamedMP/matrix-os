import { useMemo, useRef, useState } from "react";
import { useRouter } from "expo-router";

import { ProjectNameSheet } from "@/components/projects/ProjectNameSheet";
import { ProjectsListScreen } from "@/components/projects/ProjectsListScreen";
import { projectNameFailure } from "@/components/projects/project-failures";
import { projectRows } from "@/components/projects/project-rows";
import { useBackOr } from "@/components/projects/use-back-or";
import { useProjectList } from "@/components/projects/use-project-list";
import { useCreateProject } from "@/lib/queries/use-project-mutations";
import { canonicalChatRequestId } from "@/lib/requests/canonical-chat";

export default function ProjectsRoute() {
  const router = useRouter();
  const list = useProjectList();
  const create = useCreateProject();
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

  const startNaming = () => {
    create.reset();
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
      />
      <ProjectNameSheet
        visible={naming}
        title="New project"
        confirmLabel="Create"
        saving={create.isPending}
        failure={create.isError ? projectNameFailure(create.error, "Project could not be created. Try again.") : null}
        onSubmit={createProject}
        onCancel={() => setNaming(false)}
      />
    </>
  );
}
