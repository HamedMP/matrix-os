import { Redirect, useRouter } from "expo-router";
import { AgentProjectWorkspaceScreen } from "@/components/agents/agent-project-workspace-screen";
import { useGateway } from "@/app/_layout";
import { CODING_AGENTS_MOBILE_WORKSPACE } from "@/lib/feature-flags";

export default function ProjectChatsTab() {
  const router = useRouter();
  const { client, connectionState } = useGateway();

  if (!CODING_AGENTS_MOBILE_WORKSPACE) return <Redirect href="/(tabs)/apps" />;

  return (
    <AgentProjectWorkspaceScreen
      client={client}
      connectionState={connectionState}
      requestedProjectId={null}
      contentBottomInset={112}
      onOpenProject={() => {}}
      onOpenThread={({ projectId, taskId, threadId }) => {
        router.push({
          pathname: "/agents/[threadId]",
          params: {
            projectId,
            ...(taskId ? { taskId } : {}),
            threadId,
          },
        } as never);
      }}
      onNewConversation={({ projectId, taskId }) => {
        router.push({
          pathname: "/agents/new",
          params: {
            projectId,
            ...(taskId ? { taskId } : {}),
          },
        } as never);
      }}
    />
  );
}
