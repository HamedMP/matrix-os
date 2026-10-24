import type { ComposerAttachment } from "../lib/chat-attachments";
import { catalogOf, engineInstance } from "./model-test-catalog";

export const MiB = 1024 * 1024;
export const managedSelection = { instanceId: "matrix_pi_default", model: "vision" };

export function attachment(overrides: Partial<ComposerAttachment> = {}): ComposerAttachment {
  return {
    id: "att_00000000000000000000000000000001",
    uri: "file:///cache/photo.png",
    name: "photo.png",
    kind: "image",
    mimeType: "image/png",
    sizeBytes: 1024,
    ...overrides,
  };
}

export function attachmentCatalog() {
  const pi = engineInstance("matrix_pi_default", "matrix_pi", "Matrix AI", [["vision", "Vision"]]);
  pi.models.push({ ...pi.models[0]!, id: "text", displayName: "Text", supportsVision: false });
  return catalogOf(
    pi,
    { ...pi, id: "matrix_pi_own" },
    { ...pi, id: "matrix_bot_default", driverKind: "matrix_bot" },
    { ...pi, id: "codex_default", driverKind: "codex" },
  );
}
