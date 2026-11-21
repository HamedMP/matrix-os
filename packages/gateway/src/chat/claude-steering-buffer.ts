import { ChatSteerNotDeliveredError } from "./steer-delivery-error.js";

/** Corrections admitted during asynchronous child shutdown share the next prompt.
 * Bound the retained input; refusing a new correction leaves earlier receipts intact.
 */
export function createClaudeSteeringBuffer() {
  let prompt: string | undefined;
  let count = 0;
  return {
    get prompt() { return prompt; },
    append(next: string) {
      const combined = prompt === undefined ? next : `${prompt}\n\n${next}`;
      if (count >= 16 || combined.length > 256_000) throw new ChatSteerNotDeliveredError();
      prompt = combined;
      count += 1;
      return combined;
    },
  };
}
