import { useCallback } from "react";
import { Redirect, useRouter } from "expo-router";
import { AgentProjectWorkspaceScreen } from "@/components/agents/agent-project-workspace-screen";
import { useGateway } from "@/app/_layout";
import { CODING_AGENTS_MOBILE_WORKSPACE } from "@/lib/feature-flags";

export default function ProjectChatsTab() {
  const router = useRouter();
  const { client, connectionState } = useGateway();
  const openThread = useCallback(({ projectId, taskId, threadId }: {
    projectId: string;
    taskId: string | null;
    threadId: string;
  }) => {
    router.push({
      pathname: "/agents/[threadId]",
      params: {
        projectId,
        ...(taskId ? { taskId } : {}),
        threadId,
      },
    } as never);
  }, [router]);
  const newConversation = useCallback(({ projectId, taskId }: {
    projectId: string;
    taskId: string | null;
  }) => {
    router.push({
      pathname: "/agents/new",
      params: {
        projectId,
        ...(taskId ? { taskId } : {}),
      },
    } as never);
  }, [router]);

  if (!CODING_AGENTS_MOBILE_WORKSPACE) return <Redirect href="/(tabs)/apps" />;

  return (
    <AgentProjectWorkspaceScreen
      client={client}
      connectionState={connectionState}
      requestedProjectId={null}
      contentBottomInset={112}
      onOpenProject={keepProjectInTab}
      onOpenThread={openThread}
      onNewConversation={newConversation}
    />
  );
}

function keepProjectInTab() {}
