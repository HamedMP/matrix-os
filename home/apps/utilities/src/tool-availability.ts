import type { UtilityTool } from "./utilities-model";

// These workspaces require URL-backed workers, isolated code execution, or peer
// APIs that are not supported by Matrix's current opaque-origin app sandbox.
// Keep the restriction shared between the catalog and the workspace dispatcher.
const SANDBOX_LIMITED_TOOLS = [
  "blur-faces", "protect-pdf", "unlock-pdf", "compress-pdf", "verify-pdf", "pdf-workspace",
  "pdf-podcast", "check-pdf-signature", "compare-pdfs", "pdf-to-word", "pdf-to-excel",
  "pdf-to-image", "redact-pdf", "ocr-pdf",
  "image-ocr", "image-upscale", "remove-background", "zero-shot-image-tags", "image-caption-generator",
  "code-workspace",
] as const;

export interface ToolAvailability { available: boolean; reason?: string; websiteUrl?: string }
export function toolAvailability(tool: UtilityTool): ToolAvailability {
  const limited = tool.mode === "local-ai" || tool.mode === "collaboration" ||
    tool.mode === "audio" && tool.slug !== "transcription-player" ||
    SANDBOX_LIMITED_TOOLS.some((slug) => tool.slug === slug);
  if (!limited) return { available: true };
  return {
    available: false,
    reason: "This tool needs browser features that are not yet supported in this Matrix view. Use its website workspace for now. Your input is not transferred.",
    websiteUrl: `https://matrix-os.com/tools/${encodeURIComponent(tool.slug)}`,
  };
}
export function availableToolCount(tools: readonly UtilityTool[]): number {
  return tools.filter((tool) => toolAvailability(tool).available).length;
}
