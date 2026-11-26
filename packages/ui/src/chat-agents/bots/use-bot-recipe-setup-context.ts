import { useEffect, useState } from "react";
import type { BotRecipeRef, BotRecipeSetupContext } from "@matrix-os/contracts";
import type { BotClient } from "./client.js";

/** Only expose results for the selected owner and exact catalog version. */
export function useBotRecipeSetupContext(botClient: BotClient | undefined, recipe?: BotRecipeRef) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ client: BotClient | undefined; context: BotRecipeSetupContext | null; key: string } | null>(null);
  const recipeId = recipe?.recipeId, version = recipe?.version;
  const key = JSON.stringify([recipeId, version, attempt]);
  useEffect(() => {
    if (!recipeId || !version) return;
    let current = true;
    const load = async () => {
      try {
        if (!botClient?.recipeSetupContext) throw new Error("Recipe context unavailable");
        const context = await botClient.recipeSetupContext({ recipeId, version });
        if (context.recipeId !== recipeId || context.version !== version) throw new Error("Recipe changed");
        if (current) setResult({ client: botClient, key, context });
      } catch (failure: unknown) {
        console.warn("[chat-agents] Recipe setup unavailable:", failure instanceof Error ? failure.name : "UnknownError");
        if (current) setResult({ client: botClient, key, context: null });
      }
    };
    void load();
    return () => { current = false; };
  }, [botClient, recipeId, version, key]);
  const loaded = result?.key === key && result.client === botClient ? result : null;
  return { loaded, key, retry: () => setAttempt(value => value + 1) };
}
