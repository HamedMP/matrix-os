import { useRef, useState } from "react";
import type { BotRecipeRef, CanonicalChatModelSelection } from "@matrix-os/contracts";

import { canonicalChatRequestId } from "@/lib/requests/canonical-chat";

import type { AgentTemplate } from "./agent-templates";
import { useCreationAttempt } from "./creation-attempt";

interface CreateAgentOptions {
  /** `useBotRecipes().create`. Resolves to the id of the new agent's chat. */
  create: (
    recipe: BotRecipeRef,
    clientRequestId: string,
    selection?: CanonicalChatModelSelection,
    name?: string,
  ) => Promise<string>;
  /** The account and computer the agent is created for. */
  scope: string;
  onCreated: (chatId: string) => void;
}

/**
 * Creates an agent from a template, once. A press while a request is in
 * flight does nothing, and a retry of the same template under the same name
 * reuses the request id: when the first attempt reached the server but its
 * answer was lost, the server returns that agent instead of making another.
 */
export function useCreateAgent({ create, scope, onCreated }: CreateAgentOptions) {
  const attempt = useCreationAttempt();
  const inFlight = useRef(false);
  const [creating, setCreating] = useState(false);
  const [failed, setFailed] = useState(false);

  const submit = async (template: AgentTemplate, name: string) => {
    const chosenName = name.trim();
    if (inFlight.current || !chosenName) return;
    const key = `${template.recipeId}@${template.version}:${chosenName}`;
    if (attempt.current?.key !== key || attempt.current.scope !== scope) {
      attempt.current = { scope, key, requestId: canonicalChatRequestId() };
    }
    const { requestId } = attempt.current;
    inFlight.current = true;
    setCreating(true);
    setFailed(false);
    let chatId: string | null = null;
    try {
      // No model is chosen here: the computer picks the agent's model.
      chatId = await create(
        { recipeId: template.recipeId, version: template.version },
        requestId,
        undefined,
        chosenName,
      );
      if (attempt.current?.requestId === requestId) attempt.current = null;
    } catch (failure: unknown) {
      console.warn("[mobile-bots] Bot creation failed:", failure instanceof Error ? failure.name : "UnknownError");
      setFailed(true);
    } finally {
      inFlight.current = false;
      setCreating(false);
    }
    if (chatId !== null) onCreated(chatId);
  };

  return {
    creating,
    failed,
    submit,
    /** Forgets the last failure, as when the sheet is opened afresh. */
    clearFailure: () => setFailed(false),
  };
}
