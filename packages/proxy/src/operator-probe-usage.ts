import { z } from 'zod/v4';
import { readOperatorProbeJson, type OperatorProbeFinalizeInput } from '@matrix-os/contracts/funded-operator-probe';
import { normalizeWorkersAiCompletion } from './funded-relay-workers-response.js';
import { normalizeOpenAiUsage, ProbeOpenAiUsage } from './funded-relay-openai-usage.js';
import { ProbeAnthropicUsage, toUsage } from './funded-relay-usage.js';
import { FUNDED_SONNET } from './funded-relay-readiness.js';

type Evidence = Pick<OperatorProbeFinalizeInput, 'outcome' | 'usage'>;
const message = z.object({ type: z.literal('message'), model: z.literal('claude-sonnet-5'), usage: ProbeAnthropicUsage,
  content: z.unknown().optional(), stop_reason: z.string().min(1).max(64).nullable().optional() });
const completion = z.object({ model: z.string(), usage: ProbeOpenAiUsage, choices: z.tuple([z.object({
  index: z.literal(0), finish_reason: z.string().min(1).max(64).nullable().optional(), message: z.unknown().optional(),
})]) });
const sonnetStops: readonly string[] = ['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal', 'model_context_window_exceeded'];
const workersStops: readonly string[] = ['stop', 'length', 'tool_calls', 'content_filter', 'function_call'];
const assistantMessage = z.object({ role: z.literal('assistant'), content: z.string().nullable() });
const maxBytes = 64 * 1024;

/** Nonterminal usage may be partial. Still forward counts for over-bound discrepancy handling. */
export async function operatorProbeEvidence(model: string, response: Response): Promise<Evidence> {
  if (model === FUNDED_SONNET) {
    const result = message.parse(await readOperatorProbeJson(response, maxBytes));
    const reason = result.stop_reason;
    const healthy = response.ok && Array.isArray(result.content) && (reason === 'end_turn' || reason === 'max_tokens');
    return { usage: toUsage(result.usage, result.usage.output_tokens),
      outcome: !reason || !sonnetStops.includes(reason) ? 'unknown' : healthy ? 'ready' : 'not_ready' };
  }
  const raw = await readOperatorProbeJson(response, maxBytes);
  if (raw && typeof raw === 'object' && 'success' in raw && raw.success !== true) throw new Error('Invalid provider envelope');
  const result = completion.parse(normalizeWorkersAiCompletion(raw, model));
  const choice = result.choices[0], reason = choice.finish_reason;
  const healthy = response.ok && assistantMessage.safeParse(choice.message).success
    && (reason === 'stop' || reason === 'length');
  return { usage: normalizeOpenAiUsage(result.usage), outcome: !reason || !workersStops.includes(reason) ? 'unknown' : healthy ? 'ready' : 'not_ready' };
}
