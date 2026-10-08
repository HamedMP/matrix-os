import { safeToolPreview } from "./safe-activity-projection.js";

/** Private file previews retain the owner's path display. Commands and ancillary
 * details keep their sanitized canonical activity representation in every scope.
 * The adapter still validates the result against the canonical event schema.
 */
export function projectClaudeToolPreview(
  name: string,
  args: unknown,
  options: Parameters<typeof safeToolPreview>[2],
): ReturnType<typeof safeToolPreview> {
  const sanitized = safeToolPreview(name, args, { ...options, showPrivatePaths: false });
  if (!options.showPrivatePaths) return sanitized;
  const ownerPath = safeToolPreview(name, args, options);
  return ownerPath.previewKind === "path" && ownerPath.preview
    ? { ...sanitized, preview: ownerPath.preview, previewKind: "path" }
    : sanitized;
}
