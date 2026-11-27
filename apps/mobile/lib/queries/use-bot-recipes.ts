import { useAuth } from "@clerk/clerk-expo";
import { useQuery } from "@tanstack/react-query";
import type { BotRecipeRef, CanonicalChatModelSelection } from "@matrix-os/contracts";
import { fetchNativeBotRecipes, instantiateNativeBot } from "@/lib/requests/bots";

export function useBotRecipes(gatewayUrl: string | null, visible: boolean) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const query = useQuery({
    queryKey: ["native-bot-recipes", userId ?? "signed-out", gatewayUrl ?? "none"],
    enabled: Boolean(visible && gatewayUrl && isLoaded && isSignedIn && userId),
    queryFn: async () => {
      if (!gatewayUrl) throw new Error("Bot recipes could not be loaded.");
      return fetchNativeBotRecipes(getToken, gatewayUrl);
    },
  });
  return {
    recipes: query.data ?? [],
    isPending: query.isPending,
    isError: query.isError,
    /** Reads the templates again, as after a failed read. */
    refetch: () => query.refetch(),
    /**
     * Resolves to the new agent's id and the id of its chat. `name` is what the
     * person calls the agent; without one it takes the template's name.
     */
    create: async (
      recipe: BotRecipeRef,
      clientRequestId: string,
      selection?: CanonicalChatModelSelection,
      name?: string,
    ): Promise<{ agentId: string; chatId: string }> => {
      if (!gatewayUrl || !isLoaded || !isSignedIn || !userId) throw new Error("Bot could not be created.");
      const chosenName = name?.trim();
      const created = await instantiateNativeBot(getToken, gatewayUrl, {
        recipe, clientRequestId, ...(selection ? { selection } : {}), ...(chosenName ? { name: chosenName } : {}),
      });
      return { agentId: created.agent.id, chatId: created.chatId };
    },
  };
}
