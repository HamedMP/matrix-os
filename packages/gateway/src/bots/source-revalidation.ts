import { BotBrokerActionError } from './broker-actions.js';
import { isManagedPiBinding, type BotRuntimeBinding, type PiRuntimeBinding } from './runtime-registry.js';
import type { ChatGptPlanAuthority } from './chatgpt-plan.js';
import type { MatrixAnthropicAuthority } from './matrix-anthropic-api.js';

/** Current definition and live source consent must survive every prepared tool/effect boundary. */
export function createBotSourceRevalidator(deps: {
  lifetime: AbortSignal;
  revalidateDefinition(binding: BotRuntimeBinding): Promise<void>;
  chatgptPlan?: Pick<ChatGptPlanAuthority, 'revalidate'>;
  matrixOpenAi?: Pick<import("./matrix-openai-api.js").MatrixOpenAiAuthority, "revalidate">;
  matrixAnthropic?: Pick<MatrixAnthropicAuthority, 'revalidate'>;
}) {
  return async (binding: PiRuntimeBinding, signal?: AbortSignal): Promise<void> => {
    const current = AbortSignal.any([deps.lifetime, ...(signal ? [signal] : [])]);
    const assertLive = () => { if (current.aborted) throw new BotBrokerActionError('stale_generation'); };
    assertLive();
    if (!isManagedPiBinding(binding)) await deps.revalidateDefinition(binding);
    assertLive();
    if (binding.subscription && (!deps.chatgptPlan || !await deps.chatgptPlan.revalidate(binding, current))) throw new BotBrokerActionError('stale_generation');
    assertLive();
    if (binding.openaiApi && (!deps.matrixOpenAi || !await deps.matrixOpenAi.revalidate(binding, current))) throw new BotBrokerActionError("stale_generation");
    assertLive();
    if (binding.anthropicApi && (!deps.matrixAnthropic || !await deps.matrixAnthropic.revalidate(binding, current))) throw new BotBrokerActionError('stale_generation');
    assertLive();
  };
}
