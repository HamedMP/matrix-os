import { useRef } from "react";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useAuth } from "@clerk/clerk-expo";

import { BotRecipeChooser, type BotCreationAttempt } from "@/components/BotRecipeChooser";
import { TabScreen } from "@/components/shell/TabScreen";
import { useCanonicalChatSession } from "@/lib/canonical-chat-session-context";
import { useBotRecipes } from "@/lib/queries/use-bot-recipes";
import { useCanonicalChats } from "@/lib/queries/use-canonical-chats";
import { useChatProviderCatalog } from "@/lib/queries/use-chat-provider-catalog";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";
import { useShowChatScreen } from "@/lib/use-shell-navigation";

export default function AgentsScreen() {
  const { userId } = useAuth();
  const { selectChat } = useCanonicalChatSession();
  const chats = useCanonicalChats();
  const { catalog } = useChatProviderCatalog();
  const showChatScreen = useShowChatScreen();
  const gatewayUrl = chats.computer ? `${HOSTED_GATEWAY_URL}${chats.computer.gatewayPath}` : null;
  const botCreationAttempt = useRef<BotCreationAttempt | null>(null);
  const botRecipes = useBotRecipes(gatewayUrl, true);

  return (
    <TabScreen>
      <Text accessibilityRole="header" style={styles.title}>Agents</Text>
      {!gatewayUrl ? null : botRecipes.isError ? (
        <Text accessibilityRole="alert" style={styles.systemText}>Bot recipes could not be loaded. Try again.</Text>
      ) : botRecipes.isPending ? (
        <Text style={styles.systemText}>Loading bot recipes…</Text>
      ) : (
        <BotRecipeChooser
          catalog={catalog}
          recipes={botRecipes.recipes}
          onCreate={botRecipes.create}
          attemptRef={botCreationAttempt}
          attemptScope={`${userId ?? ""}:${gatewayUrl}`}
          onOpenChat={(chatId) => {
            selectChat(chatId);
            void chats.invalidate();
            showChatScreen();
          }}
        />
      )}
    </TabScreen>
  );
}

const styles = StyleSheet.create((theme) => ({
  title: {
    ...theme.v2.text.title,
    marginTop: theme.v2.space[8],
    marginHorizontal: theme.v2.space[20],
    color: theme.v2.colors.textDefault,
  },
  systemText: {
    ...theme.v2.text.captionMedium,
    color: theme.v2.colors.textSubtle,
    textAlign: "center",
  },
}));
