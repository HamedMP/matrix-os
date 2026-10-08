import { useMemo, useState } from "react";
import { useAuth } from "@clerk/clerk-expo";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigation } from "expo-router";

import { NewAgentScreen } from "@/components/agents/NewAgentScreen";
import { TemplateSetupSheet } from "@/components/agents/TemplateSetupSheet";
import { filterTemplates, templateSetupPrompt, type AgentTemplate } from "@/components/agents/agent-templates";
import { requestChatDraft } from "@/components/agents/chat-draft-request";
import { useCreateAgent } from "@/components/agents/use-create-agent";
import { useCanonicalChatSession } from "@/lib/canonical-chat-session-context";
import { useBotRecipes } from "@/lib/queries/use-bot-recipes";
import { useCanonicalChats } from "@/lib/queries/use-canonical-chats";
import { mobileQueryKeys } from "@/lib/requests/query-keys";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";
import { useShowChatScreen } from "@/lib/use-shell-navigation";

export default function NewAgentRoute() {
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const { userId } = useAuth();
  const { selectChat, startDraftChat } = useCanonicalChatSession();
  const chats = useCanonicalChats();
  const showChatScreen = useShowChatScreen();
  const gatewayUrl = chats.computer ? `${HOSTED_GATEWAY_URL}${chats.computer.gatewayPath}` : null;
  const recipes = useBotRecipes(gatewayUrl, true);
  const [query, setQuery] = useState("");
  const [template, setTemplate] = useState<AgentTemplate | null>(null);
  const templates = useMemo(() => filterTemplates(recipes.recipes, query), [recipes.recipes, query]);

  const leaveForChat = () => {
    setTemplate(null);
    // The Agents tab is left on its list, so coming back to it does not show
    // this screen again. An agent can finish being created after this screen
    // was left, and then there is nothing of it to go back from.
    const screensInTab = navigation.getState()?.routes.length ?? 0;
    if (navigation.isFocused() && screensInTab > 1) navigation.goBack();
    showChatScreen();
  };

  const creation = useCreateAgent({
    create: recipes.create,
    scope: `${userId ?? ""}:${gatewayUrl ?? ""}`,
    onCreated: (chatId) => {
      selectChat(chatId);
      void chats.invalidate();
      leaveForChat();
    },
  });

  const openSetup = (chosen: AgentTemplate) => {
    creation.clearFailure();
    setTemplate(chosen);
  };

  const setUpInChat = () => {
    if (!template) return;
    startDraftChat();
    requestChatDraft(templateSetupPrompt(template));
    leaveForChat();
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
      <NewAgentScreen
        state={failed ? "error" : recipes.isPending ? "loading" : "ready"}
        templates={templates}
        query={query}
        onChangeQuery={setQuery}
        onRetry={retry}
        onBack={() => navigation.goBack()}
        onSelectTemplate={openSetup}
      />
      <TemplateSetupSheet
        template={template}
        creating={creation.creating}
        failed={creation.failed}
        onCreate={(name) => {
          if (template) void creation.submit(template, name);
        }}
        onSetUpInChat={setUpInChat}
        onClose={() => setTemplate(null)}
      />
    </>
  );
}
