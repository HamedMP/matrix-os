import { useState } from "react";
import { Alert } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import { AgentChatScreen } from "@/components/agents/AgentChatScreen";
import { AgentDetailsSheet } from "@/components/agents/AgentDetailsSheet";
import { agentRunsOn } from "@/components/agents/agent-copy";
import { AGENTS_LIST_ROUTE } from "@/components/agents/agent-routes";
import { useAgentChatId } from "@/components/agents/use-agent-chat-id";
import { useAgentThread } from "@/components/agents/use-agent-thread";
import { useAgentStatuses } from "@/lib/queries/use-agent-statuses";
import { useAgents, useArchiveAgent } from "@/lib/queries/use-agents";
import { AgentRequestError } from "@/lib/requests/bots";

const NO_TASKS: never[] = [];

export default function AgentChatRoute() {
  const params = useLocalSearchParams<{ agentId?: string | string[] }>();
  const agentId = [params.agentId].flat()[0] ?? "";
  const router = useRouter();
  const library = useAgents();
  const { statuses } = useAgentStatuses(library.agents);
  const archive = useArchiveAgent();
  const [detailsOpen, setDetailsOpen] = useState(false);

  const agent = library.agents.find((candidate) => candidate.id === agentId) ?? null;
  // The agent last read stays on screen while the list is read again, and
  // while this screen slides away once the agent has been archived.
  const [kept, setKept] = useState(agent);
  if (agent && (agent.id !== kept?.id || agent.revision !== kept.revision)) setKept(agent);
  const shown = agent ?? (kept?.id === agentId ? kept : null);
  const name = shown?.name ?? "Agent";

  const chat = useAgentChatId(agentId, Object.hasOwn(statuses, agentId) ? statuses[agentId].chatId : null);
  const thread = useAgentThread({ agent: shown, chatId: chat.chatId });
  const { botChat } = thread;
  const fromTemplate = Boolean(shown?.recipeRef);
  // The status is read after every change, so its copy of the model is the newer one.
  const modelSelection = botChat.snapshot?.selection ?? shown?.selection;

  const refreshAgent = async () => {
    await Promise.all([botChat.refresh(), library.refetch()]);
  };

  // This screen can be the only one in its tab, as after an agent was created
  // from a screen that had nothing under it. The list is then put in its place.
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace(AGENTS_LIST_ROUTE as never);
  };

  const leaveToList = () => {
    if (router.canDismiss()) router.dismissAll();
    else router.replace(AGENTS_LIST_ROUTE as never);
  };

  const archiveAgent = async (target: { id: string; revision: number }) => {
    try {
      // The list is read again whatever the answer, so a retry carries the current revision.
      await archive.mutateAsync({ agentId: target.id, baseRevision: target.revision });
    } catch (error: unknown) {
      console.warn("[mobile] agent archive failed", error instanceof Error ? error.name : "unknown");
      if (error instanceof AgentRequestError && error.reason === "conflict") Alert.alert("This agent changed. Try again.");
      else Alert.alert("Agent could not be archived", "Try again.");
      return;
    }
    setDetailsOpen(false);
    leaveToList();
  };

  const confirmArchive = (target: { id: string; name: string; revision: number }) => {
    Alert.alert(`Archive ${target.name}?`, "It leaves your agents list. This cannot be undone from the app.", [
      { text: "Cancel", style: "cancel" },
      { text: "Archive", style: "destructive", onPress: () => void archiveAgent(target) },
    ]);
  };

  return (
    <>
      <AgentChatScreen
        agent={{ id: agentId, name }}
        state={chat.chatId ? "ready" : chat.failed ? "failed" : "loading"}
        onBack={goBack}
        onOpenDetails={() => setDetailsOpen(true)}
        onRetry={chat.retry}
        notice={fromTemplate && botChat.isError ? "Agent status could not be loaded. Try again." : null}
        messages={thread.messages}
        chatId={chat.chatId}
        renderRequest={thread.renderRequest}
        renderResults={thread.renderResults}
        footer={thread.footer}
        composer={thread.composer}
      />
      <AgentDetailsSheet
        visible={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        agent={{ id: agentId, name, description: shown?.description }}
        runsOn={shown && modelSelection
          ? agentRunsOn({ recipeRef: shown.recipeRef, selection: modelSelection }, thread.catalog)
          : null}
        authority={botChat.snapshot?.authority ?? null}
        tasks={botChat.snapshot?.tasks ?? NO_TASKS}
        selection={fromTemplate ? modelSelection : undefined}
        catalog={thread.catalog}
        actionsAvailable={!botChat.isError}
        onRevoke={botChat.revoke}
        onMemory={botChat.memory}
        onSelectModel={botChat.snapshot?.revision ? botChat.updateModel : undefined}
        onRefresh={refreshAgent}
        archiving={archive.isPending}
        onArchive={agent ? () => confirmArchive(agent) : undefined}
      />
    </>
  );
}
