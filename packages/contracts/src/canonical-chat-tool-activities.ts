import type { CanonicalChatRun, CanonicalChatRunActivity } from "./canonical-chat.js";
import { canonicalChatToolDetail } from "#canonical-chat-tool-details";

export type CanonicalToolActivityState = "running" | "completed" | "partial" | "stopped" | "failed";

export interface CanonicalToolActivity {
  id: string;
  /** reasoning | plan | command | file_change | mcp_tool | dynamic_tool | delegation | web_search | image_inspection | phase | tool */
  kind: string;
  state: CanonicalToolActivityState;
  label: string;
  preview?: string;
  previewKind?: "command" | "path" | "text";
  detail?: string;
}

function activityState(
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "partial",
): CanonicalToolActivityState {
  if (status === "failed") return "failed";
  if (status === "cancelled") return "stopped";
  if (status === "partial") return "partial";
  if (status === "completed") return "completed";
  return "running";
}

function isDuplicateProviderModelStatus(
  run: CanonicalChatRun,
  activity: Extract<CanonicalChatRunActivity, { type: "agent.activity" }>,
): boolean {
  const namespaceSeparator = run.selection.model.indexOf(":");
  const model = namespaceSeparator >= 0 ? run.selection.model.slice(namespaceSeparator + 1) : run.selection.model;
  const expected = `Current model: ${model}`.toLowerCase();
  return activity.kind === "phase"
    && activity.label === "Working"
    && [activity.summary, activity.preview].some((value) => value?.trim().toLowerCase() === expected);
}

/**
 * Merges a run's tool.progress + tool.output + agent.activity entries into
 * one ordered, deduplicated activity list -- mirrors desktop's
 * runPresentation (canonical-chat-presentation.ts) so mobile shows the same
 * range of activity kinds (reasoning, plan, command, file_change, mcp_tool,
 * dynamic_tool, delegation, web_search, image_inspection) and real tool
 * calls in progress, not just "reasoning"/"command" labels.
 */
export function canonicalChatToolActivities(run: CanonicalChatRun, activities: CanonicalChatRunActivity[]): CanonicalToolActivity[] {
  const ordered = activities
    .filter((activity) => activity.runId === run.id).slice(-500)
    .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));

  const toolProgress = new Map<string, Extract<CanonicalChatRunActivity, { type: "tool.progress" }>>();
  const agentActivities = new Map<string, Extract<CanonicalChatRunActivity, { type: "agent.activity" }>>();
  const toolOutput = new Map<string, string[]>();
  const order: Array<{ type: "tool" | "agent"; id: string }> = [];

  for (const activity of ordered) {
    if (activity.type === "tool.progress") {
      if (!toolProgress.has(activity.toolCallId)) order.push({ type: "tool", id: activity.toolCallId });
      toolProgress.set(activity.toolCallId, activity);
    } else if (activity.type === "agent.activity") {
      if (isDuplicateProviderModelStatus(run, activity)) continue;
      if (!agentActivities.has(activity.activityId)) order.push({ type: "agent", id: activity.activityId });
      agentActivities.set(activity.activityId, activity);
    } else if (activity.type === "tool.output") {
      const output = toolOutput.get(activity.toolCallId) ?? [];
      output.push(activity.truncated ? `${activity.text}\nOutput was truncated for display.` : activity.text);
      toolOutput.set(activity.toolCallId, output);
    }
  }

  return order.flatMap(({ type, id }): CanonicalToolActivity[] => {
    if (type === "agent") {
      const activity = agentActivities.get(id);
      if (!activity) return [];
      const preview = activity.preview ?? activity.summary;
      const detail = canonicalChatToolDetail(activity.detail ?? activity.summary, toolOutput.get(activity.activityId));
      return [{
        id: activity.activityId,
        kind: activity.kind,
        state: activityState(activity.status),
        label: activity.label,
        ...(preview ? { preview, previewKind: activity.previewKind ?? "text" } : {}),
        ...(detail ? { detail } : {}),
      }];
    }
    const activity = toolProgress.get(id);
    if (!activity) return [];
    const detail = canonicalChatToolDetail(undefined, toolOutput.get(activity.toolCallId));
    return [{
      id: activity.toolCallId,
      kind: "tool",
      state: activityState(activity.status),
      label: activity.label,
      ...(detail ? { detail } : {}),
    }];
  });
}
