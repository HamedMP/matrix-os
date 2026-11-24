import { isManagedCustomBot } from "@matrix-os/contracts";
import type { ComponentProps } from "react";
import { AgentSetupChat } from "./AgentSetupChat.js";
import { useBotRecipeSetupContext } from "./bots/use-bot-recipe-setup-context.js";
import type { BotClient } from "./bots/client.js";
import { chatAgentButtonClass } from "./theme.js";

/** A named template keeps its server-owned defaults separate from the saved owner's draft. */
export function AgentConversationEditor({ botClient, ...props }: ComponentProps<typeof AgentSetupChat> & { botClient?: BotClient }) {
  const agent = props.editing;
  const ref = agent !== "new" && !isManagedCustomBot(agent) ? agent.recipeRef : undefined;
  const { loaded, retry } = useBotRecipeSetupContext(botClient, ref);
  if (!ref) return <AgentSetupChat {...props} />;
  if (!loaded) return <p role="status" className="text-sm">Loading recipe setup…</p>;
  if (!loaded.context) return <div className="grid gap-3">
    <p role="alert">This recipe version is unavailable. You can still review the saved configuration.</p>
    <button type="button" className={chatAgentButtonClass} onClick={retry}>Retry recipe setup</button>
    {props.children}
  </div>;
  return <AgentSetupChat {...props} seed={{ kind: "recipe", ...ref }} recipeContext={loaded.context} />;
}
