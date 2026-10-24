import { createBoundedAssistantPreview } from "./bounded-assistant-preview.js";
import type { CapturedAssistantText } from "./safe-activity-projection.js";

/** Apply the same preview policy before Hermes' segment/batching buffers grow.
 * Captures remain masked and only complete retained placeholders are sealed. */
export function createHermesOutputPreview() {
  const preview = createBoundedAssistantPreview();
  return {
    get truncated() { return preview.truncated; },
    append(value: CapturedAssistantText): CapturedAssistantText | undefined {
      const retained = preview.append({ messageId: "hermes_preview", delta: value.text, credentials: value.captures });
      return retained ? { text: retained.delta, captures: retained.credentials ?? [] } : undefined;
    },
    truncate(): CapturedAssistantText | undefined {
      const retained = preview.truncate("hermes_preview");
      return retained ? { text: retained.delta, captures: [] } : undefined;
    },
  };
}
