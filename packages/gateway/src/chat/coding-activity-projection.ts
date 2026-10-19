import { PlaintextToolPreviewSchema } from "./plaintext-tool-preview.js";
import { CanonicalChatAgentActivityPayloadSchema, type AgentThreadEvent } from "@matrix-os/contracts";

/** Display metadata is optional evidence, never authority for execution outcome. */
export function projectCodingActivity(event: Extract<AgentThreadEvent, { type: "tool.started" | "tool.completed" }>) {
  const fields = CanonicalChatAgentActivityPayloadSchema.shape;
  const label = fields.label.safeParse("displayName" in event ? event.displayName : undefined);
  // Plaintext from an older detached runner remains coarse client metadata.
  // Full private commands require the authenticated encrypted preview path.
  const preview = PlaintextToolPreviewSchema.safeParse(event.preview);
  const detail = fields.detail.safeParse(event.detail);
  // Validate against the destination contract, not a second, drifting safety regex.
  // Omit rejected optional text; retain identity/status and a safe generic label.
  return {
    label: label.success ? label.data : "Tool",
    ...(preview.success && preview.data && event.previewKind
      ? { preview: preview.data, previewKind: event.previewKind } : {}),
    ...(detail.success && detail.data ? { detail: detail.data } : {}),
    ...(event.protectedPreview ? { protectedPreview: event.protectedPreview } : {}),
  };
}
