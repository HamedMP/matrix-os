import { useAuth } from "@clerk/clerk-expo";
import { useQuery } from "@tanstack/react-query";
import type { BotRecipeRef } from "@matrix-os/contracts";
import { fetchNativeBotRecipes, instantiateNativeBot } from "@/lib/requests/bots";

export function useBotRecipes(gatewayUrl: string | null, visible: boolean) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const query = useQuery({
    queryKey: ["native-bot-recipes", userId ?? "signed-out", gatewayUrl ?? "none"],
    enabled: Boolean(visible && gatewayUrl && isLoaded && isSignedIn && userId),
    queryFn: async () => {
      const token = await getToken();
      if (!token || !gatewayUrl) throw new Error("Bot recipes could not be loaded.");
      return fetchNativeBotRecipes(token, gatewayUrl);
    },
  });
  return {
    recipes: query.data ?? [],
    isPending: query.isPending,
    isError: query.isError,
    create: async (recipe: BotRecipeRef, clientRequestId: string) => {
      const token = await getToken();
      if (!token || !gatewayUrl) throw new Error("Bot could not be created.");
      return (await instantiateNativeBot(token, gatewayUrl, { recipe, clientRequestId })).chatId;
    },
  };
}
