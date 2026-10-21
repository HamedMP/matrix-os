import { useMemo, useState } from "react";
import { useAuth } from "@clerk/clerk-expo";
import { useQueryClient } from "@tanstack/react-query";
import { Stack, useNavigation, useRouter } from "expo-router";

import { InspirationSheet } from "@/components/agents/InspirationSheet";
import { NewAgentScreen } from "@/components/agents/NewAgentScreen";
import { TemplateSetupSheet } from "@/components/agents/TemplateSetupSheet";
import {
  ALL_CATEGORIES,
  buildAgentGallery,
  GALLERY_CATEGORIES,
  inspirationSetupPrompt,
} from "@/components/agents/agent-gallery";
import type { AgentInspiration } from "@/components/agents/agent-inspirations.generated";
import { agentChatRoute } from "@/components/agents/agent-routes";
import { templateSetupPrompt, type AgentTemplate } from "@/components/agents/agent-templates";
import { requestChatDraft } from "@/components/agents/chat-draft-request";
import { useShowChatAfterClosing } from "@/components/agents/chat-handoff";
import { useCreateAgent } from "@/components/agents/use-create-agent";
import { useCanonicalChatSession } from "@/lib/canonical-chat-session-context";
import { useAgents } from "@/lib/queries/use-agents";
import { useBotRecipes } from "@/lib/queries/use-bot-recipes";
import { useCanonicalChats } from "@/lib/queries/use-canonical-chats";
import { mobileQueryKeys } from "@/lib/requests/query-keys";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";
import { useShowChatScreen } from "@/lib/use-shell-navigation";

export default function NewAgentRoute() {
  const navigation = useNavigation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { userId } = useAuth();
  const { startDraftChat } = useCanonicalChatSession();
  const chats = useCanonicalChats();
  const agents = useAgents();
  const showChatScreen = useShowChatScreen();
  const showChatAfterClosing = useShowChatAfterClosing();
  const gatewayUrl = chats.computer ? `${HOSTED_GATEWAY_URL}${chats.computer.gatewayPath}` : null;
  const recipes = useBotRecipes(gatewayUrl, true);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(ALL_CATEGORIES);
  const [template, setTemplate] = useState<AgentTemplate | null>(null);
  const [inspiration, setInspiration] = useState<AgentInspiration | null>(null);
  const gallery = useMemo(
    () => buildAgentGallery(recipes.recipes, { query, category }),
    [recipes.recipes, query, category],
  );

  const creation = useCreateAgent({
    create: recipes.create,
    scope: `${userId ?? ""}:${gatewayUrl ?? ""}`,
    onCreated: ({ agentId }) => {
      setTemplate(null);
      // The chat list has gained the agent's chat, and the agents list the agent.
      void chats.invalidate();
      void agents.refetch();
      // The agent's chat takes this screen's place, so going back from it
      // shows the list. An agent can finish being created after this screen
      // was left; its chat then opens on top of wherever the person is.
      if (navigation.isFocused()) router.replace(agentChatRoute(agentId) as never);
      else router.push(agentChatRoute(agentId) as never);
    },
  });

  const openSetup = (chosen: AgentTemplate) => {
    creation.clearFailure();
    setInspiration(null);
    setTemplate(chosen);
  };

  const openInspiration = (chosen: AgentInspiration) => {
    setTemplate(null);
    setInspiration(chosen);
  };

  /** Starts a new chat whose composer holds `prompt`, and shows it. */
  const buildInChat = (prompt: string) => {
    startDraftChat();
    requestChatDraft(prompt);
    setTemplate(null);
    setInspiration(null);
    const screensInTab = navigation.getState()?.routes.length ?? 0;
    if (!showChatAfterClosing || !navigation.isFocused() || screensInTab < 2) {
      showChatScreen();
      return;
    }
    // This screen closes first, so the Agents tab is on its list the next
    // time it is opened. The tab's layout shows the chat once the tabs have
    // taken that in: asked for in this same step, the switch is dropped.
    const stopWaiting = showChatAfterClosing();
    navigation.goBack();
    if ((navigation.getState()?.routes.length ?? 0) < screensInTab) return;
    // Nothing closed, so no change is coming for the layout to wait for.
    stopWaiting();
    showChatScreen();
  };

  // Without a computer there is nothing to read the templates from.
  const failed = recipes.isError || (!chats.computer && chats.isError);

  const retry = () => {
    if (gatewayUrl) {
      void recipes.refetch();
      return;
    }
    // The templates are read by themselves once the computer is known.
    void queryClient.invalidateQueries({ queryKey: mobileQueryKeys.activeComputer(userId ?? "signed-out") });
  };

  return (
    <>
      {/* A sheet's button can leave this screen for the Chats tab. The tab
          hides it within the same moment, which would cut a slide short and
          leave the rest to play when the Agents tab is next opened. */}
      <Stack.Screen options={{ animation: template || inspiration ? "none" : "default" }} />
      <NewAgentScreen
        state={failed ? "error" : recipes.isPending ? "loading" : "ready"}
        templates={gallery.templates}
        inspirations={gallery.inspirations}
        query={query}
        onChangeQuery={setQuery}
        categories={GALLERY_CATEGORIES}
        category={category}
        onChangeCategory={setCategory}
        onRetry={retry}
        onBack={() => navigation.goBack()}
        onSelectTemplate={openSetup}
        onSelectInspiration={openInspiration}
      />
      <TemplateSetupSheet
        template={template}
        creating={creation.creating}
        failed={creation.failed}
        onCreate={(name) => {
          if (template) void creation.submit(template, name);
        }}
        onSetUpInChat={() => {
          if (template) buildInChat(templateSetupPrompt(template));
        }}
        onClose={() => setTemplate(null)}
      />
      <InspirationSheet
        inspiration={inspiration}
        onBuildInChat={() => {
          if (inspiration) buildInChat(inspirationSetupPrompt(inspiration));
        }}
        onClose={() => setInspiration(null)}
      />
    </>
  );
}
