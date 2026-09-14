import { CanonicalChatAgentActivityPayloadSchema, type AgentThreadEvent } from "@matrix-os/contracts";

/** Display metadata is optional evidence, never authority for execution outcome. */
export function projectCodingActivity(event: Extract<AgentThreadEvent, { type: "tool.started" }>) {
  const fields = CanonicalChatAgentActivityPayloadSchema.shape;
  const label = fields.label.safeParse(event.displayName);
  const preview = fields.preview.safeParse(event.preview);
  const detail = fields.detail.safeParse(event.detail);
  // Validate against the destination contract, not a second, drifting safety regex.
  // Omit rejected optional text; retain identity/status and a safe generic label.
  return {
    label: label.success ? label.data : "Tool",
    ...(preview.success && preview.data && event.previewKind
      ? { preview: preview.data, previewKind: event.previewKind } : {}),
    ...(detail.success && detail.data ? { detail: detail.data } : {}),
  };
}
