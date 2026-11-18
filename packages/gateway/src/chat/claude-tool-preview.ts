import { CanonicalProviderRunEventSchema, type CanonicalProviderRunEvent } from "./provider-adapter.js";
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

export type ClaudeActivity = {
  activityId: string;
  kind: ReturnType<typeof claudeActivity>["kind"] | "reasoning";
  label: string;
  preview?: string;
  previewKind?: "command" | "path" | "text";
  detail?: string;
};

export function claudeActivity(name: string) {
  const normalized = name.trim().toLowerCase();
  if (normalized === "croncreate") {
    return {
      kind: "dynamic_tool" as const,
      label: "Schedule in this Claude session",
      detail: "Runs while this session is active, for up to 7 days. A Matrix Computer restart or update can stop it.",
    };
  }
  if (["bash", "shell", "terminal", "execute", "run_command"].includes(normalized)) {
    return { kind: "command" as const, label: "Run command" };
  }
  if (["write", "edit", "apply_patch", "notebookedit"].includes(normalized)) {
    return { kind: "file_change" as const, label: "Update file" };
  }
  if (["websearch", "webfetch", "web_search"].includes(normalized)) {
    return { kind: "web_search" as const, label: "Search the web" };
  }
  if (["task", "agent", "delegate"].includes(normalized)) {
    return { kind: "delegation" as const, label: "Delegated task" };
  }
  return { kind: "dynamic_tool" as const, label: name };
}

export function canonicalClaudeActivityEvent(
  activity: ClaudeActivity,
  status: "running" | "completed",
): CanonicalProviderRunEvent {
  const fullProjection = CanonicalProviderRunEventSchema.safeParse({
    type: "agent.activity",
    ...activity,
    status,
  });
  if (fullProjection.success) return fullProjection.data;

  let retained = CanonicalProviderRunEventSchema.parse({
    type: "agent.activity",
    activityId: activity.activityId,
    kind: activity.kind,
    label: activity.label,
    status,
  });
  // Validate optional fields independently: an unavailable path detail must
  // not erase a safe command preview. Preview and kind remain one atomic pair.
  for (const fields of [
    activity.preview === undefined ? undefined : { preview: activity.preview, previewKind: activity.previewKind },
    activity.detail === undefined ? undefined : { detail: activity.detail },
  ]) {
    if (!fields) continue;
    const candidate = CanonicalProviderRunEventSchema.safeParse({ ...retained, ...fields });
    if (candidate.success) retained = candidate.data;
  }
  return retained;
}
