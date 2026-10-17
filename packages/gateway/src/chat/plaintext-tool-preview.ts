import { CanonicalChatAgentActivityPayloadSchema } from "@matrix-os/contracts";

const fields = CanonicalChatAgentActivityPayloadSchema.shape;
// Provider ingress and general/export views retain the old coarse 1K/4KB
// label policy. The wider owner OUTPUT contract is available only after
// authenticated command-sidecar decryption, never for raw provider arguments.
export const PlaintextToolPreviewSchema = fields.summary.unwrap().and(fields.preview.unwrap()).optional();

type PreviewFields = { preview?: string; previewKind?: "command" | "path" | "text" };

/** Copy optional preview metadata without changing activity identity/outcome. */
export function projectPlaintextToolPreview<T extends PreviewFields>(activity: T): Omit<T, "preview" | "previewKind"> & PreviewFields {
  const { preview, previewKind, ...metadata } = activity;
  const safe = PlaintextToolPreviewSchema.safeParse(preview);
  return { ...metadata, ...(safe.success && safe.data && previewKind ? { preview: safe.data, previewKind } : {}) };
}
