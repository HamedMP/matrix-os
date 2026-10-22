import type { ProtectedToolOutput } from "./protected-tool-output.mjs";
export function codexCommandPreview(value: unknown, toolCallId: string, key?: Buffer): {
  preview?: string;
  previewKind?: "command";
  protectedPreview?: ProtectedToolOutput;
};
