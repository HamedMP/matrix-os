import { isAllowedCommandPreview, MAX_PUBLIC_COMMAND_PREVIEW_CHARS, MAX_PUBLIC_COMMAND_PREVIEW_BYTES } from "@matrix-os/contracts/command-preview-policy";
import { sealToolPreview } from "./protected-tool-output.mjs";

// Commands are owner content. Paths and credential identifiers alone are not
// secrets; assignments, auth headers, credential flags and known values are.
const PRIVATE_DISPLAY = /(?:^|[\s"'`(=:<>|;&])\/(?=[A-Za-z0-9._~-])|[A-Za-z]:[\\/]|\.ssh\/|id_rsa|stack trace/i;

/** Never put complete private commands in a detached journal's plaintext.
 * Missing keys leave the old safe display fallback; invalid optional metadata
 * never changes tool identity or outcome. */
export function codexCommandPreview(value, toolCallId, key) {
  if (typeof value !== "string") return {};
  const command = value.trim();
  if (!isAllowedCommandPreview(command)) return {};
  const publicPreview = command.length <= MAX_PUBLIC_COMMAND_PREVIEW_CHARS
    && Buffer.byteLength(command) <= MAX_PUBLIC_COMMAND_PREVIEW_BYTES
    && !PRIVATE_DISPLAY.test(command) && !/[\r\n]/.test(command) ? command : undefined;
  return {
    ...(publicPreview ? { preview: publicPreview, previewKind: "command" } : {}),
    ...(key ? { protectedPreview: sealToolPreview(key, toolCallId, command) } : {}),
  };
}
