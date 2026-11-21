import { ChatSteerNotDeliveredError } from "./steer-delivery-error.js";
import { z } from "zod/v4";
import type { ChatRunContext } from "@matrix-os/contracts";
import { contextPrompt } from "./agent-context.js";
import { parseCanonicalProviderRunInput, type CanonicalProviderRunInput } from "./provider-adapter.js";

/** Corrections admitted during asynchronous child shutdown share the next prompt.
 * Bound the retained input; refusing a new correction leaves earlier receipts intact.
 */
export function createClaudeSteeringBuffer(
  input: CanonicalProviderRunInput,
  protectedContext: () => ChatRunContext | undefined = () => undefined,
) {
  let prompt: string | undefined;
  let count = 0;
  return {
    get prompt() { return prompt; },
    append(next: string) {
      const combined = prompt === undefined ? next : `${prompt}\n\n${next}`;
      if (count >= 16) throw new ChatSteerNotDeliveredError();
      // Validate the actual replacement shape, including history overhead, before
      // mutating accepted input. Keep provider and message-part limits authoritative.
      try {
        parseCanonicalProviderRunInput({ ...input, nativeScheduled: undefined,
          prompt: contextPrompt(combined, protectedContext(), { deferIntegrationGuidance: true }),
          parts: [{ type: "text", text: combined }],
        });
      } catch (error: unknown) {
        if (error instanceof z.ZodError) throw new ChatSteerNotDeliveredError();
        throw error;
      }
      prompt = combined;
      count += 1;
      return combined;
    },
  };
}
