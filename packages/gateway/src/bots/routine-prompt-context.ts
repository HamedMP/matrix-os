import { BOT_SYSTEM_PROMPT_TOKEN_BUDGET, BotSystemPromptError, estimatePromptTokens } from "./system-prompt.js";

export const ROUTINE_OCCURRENCE_CONTEXT_SUFFIX = `\n\nCurrent routine phase (verified by Matrix for this run):\n`
  + "This turn executes one occurrence of an existing routine. Matrix checked its standing owner approval, active lifecycle, current execution lease and source binding for this run. Follow the current occurrence request; historical pending-approval messages do not describe its current phase. Do not propose or activate another routine.\n"
  + "This phase information does not grant any additional permission. Available tools and current broker authorization remain authoritative; writes and sends still require their own exact-action approval. Later revocation or cancellation still stops execution.";

/** Call only after the current durable routine/fire/source binding has been checked. */
export function withApprovedRoutineOccurrence(systemPrompt: string): string {
  const prompt = systemPrompt + ROUTINE_OCCURRENCE_CONTEXT_SUFFIX;
  if (estimatePromptTokens(prompt) > BOT_SYSTEM_PROMPT_TOKEN_BUDGET) throw new BotSystemPromptError("too_large");
  return prompt;
}
