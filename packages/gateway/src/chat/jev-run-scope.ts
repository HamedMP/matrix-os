import { JevInboxTriageBindingSchema, type ChatRunContext } from "@matrix-os/contracts";
import type { HermesJevScope } from "./hermes-integration-capability.js";

/** Context is persisted by the gateway after admission; never derive authority from prompt text. */
export function jevScopeForRun(ownerId: string, runId: string, context?: ChatRunContext): HermesJevScope | undefined {
  const agent = context?.agent;
  const recipe = agent?.recipe;
  if (!recipe?.skills.some((skill) => skill.id === "matrix-jev-email-triage")) return undefined;
  const binding = JevInboxTriageBindingSchema.safeParse(recipe.jevInboxTriage);
  if (!agent || !binding.success || binding.data.ownerId !== ownerId
    || !recipe.integrations.some((entry) => entry.service === "gmail"
      && entry.accountLabel === binding.data.accountLabel)) throw new Error("Jev run binding unavailable");
  const { version: _version, ownerId: _ownerId, ...account } = binding.data;
  return { kind: "jev_inbox_preview", runId, agentId: agent.id, revision: agent.revision, account };
}
