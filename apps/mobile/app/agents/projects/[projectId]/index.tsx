import { useCallback } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useGateway } from "@/app/_layout";
import {
  AgentProjectWorkspaceScreen,
  type AgentConversationIdentity,
} from "@/components/agents/agent-project-workspace-screen";

export default function ProjectAgentRoute() {
  const params = useLocalSearchParams<{ projectId?: string | string[] }>();
  const router = useRouter();
  const { client, connectionState } = useGateway();
  const requestedProjectId = firstRouteParam(params.projectId);

  const openProject = useCallback((projectId: string) => {
    router.replace({
      pathname: "/agents/projects/[projectId]",
      params: { projectId },
    } as never);
  }, [router]);

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

  return (
    <AgentProjectWorkspaceScreen
      client={client}
      connectionState={connectionState}
      requestedProjectId={requestedProjectId}
      onOpenProject={openProject}
      onOpenThread={openThread}
      onNewConversation={newConversation}
    />
  );
}

function firstRouteParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}
