import { useCallback } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useGateway } from "@/app/_layout";
import {
  AgentProjectWorkspaceScreen,
  type AgentConversationIdentity,
} from "@/components/agents/agent-project-workspace-screen";
import type { AgentWorkspaceViewMode } from "@/lib/agent-workspace-state";

export function AgentProjectRoute({
  routeViewMode,
}: {
  routeViewMode: AgentWorkspaceViewMode | null;
}) {
  const params = useLocalSearchParams<{ projectId?: string | string[] }>();
  const router = useRouter();
  const { client, connectionState } = useGateway();
  const requestedProjectId = firstRouteParam(params.projectId);

  const openProject = useCallback((projectId: string) => {
    router.replace({
      pathname: projectPath(routeViewMode),
      params: { projectId },
    } as never);
  }, [routeViewMode, router]);

  const openThread = useCallback((identity: AgentConversationIdentity) => {
    router.push({
      pathname: "/agents/[threadId]",
      params: {
        projectId: identity.projectId,
        ...(identity.taskId ? { taskId: identity.taskId } : {}),
        threadId: identity.threadId,
      },
    } as never);
  }, [router]);

  const newConversation = useCallback((identity: { projectId: string; taskId: string | null }) => {
    router.push({
      pathname: "/agents/new",
      params: {
        projectId: identity.projectId,
        ...(identity.taskId ? { taskId: identity.taskId } : {}),
      },
    } as never);
  }, [router]);

  const changeViewMode = useCallback((viewMode: AgentWorkspaceViewMode) => {
    router.replace({
      pathname: projectPath(viewMode),
      params: { projectId: requestedProjectId },
    } as never);
  }, [requestedProjectId, router]);

  return (
    <AgentProjectWorkspaceScreen
      client={client}
      connectionState={connectionState}
      requestedProjectId={requestedProjectId}
      onOpenProject={openProject}
      onOpenThread={openThread}
      onNewConversation={newConversation}
      onViewModeChange={changeViewMode}
      routeViewMode={routeViewMode}
    />
  );
}

function projectPath(viewMode: AgentWorkspaceViewMode | null) {
  return viewMode === "kanban"
    ? "/agents/projects/[projectId]/board"
    : "/agents/projects/[projectId]";
}

function firstRouteParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}
