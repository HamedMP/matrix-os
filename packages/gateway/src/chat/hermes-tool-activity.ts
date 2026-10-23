import type { CanonicalProviderRunEvent } from "./provider-adapter.js";
type HermesActivity = Extract<CanonicalProviderRunEvent, { type: "agent.activity" }>;

export function hermesToolActivity(name: string): Pick<HermesActivity, "kind" | "label"> {
  const normalized = name.trim().toLowerCase();
  if (["terminal", "shell", "bash", "execute", "execute_code", "run_command"].includes(normalized)) {
    return { kind: "command", label: "Run command" };
  }
  if (["web_search", "web_extract", "browser", "browser_use"].includes(normalized)) {
    return { kind: "web_search", label: "Search the web" };
  }
  if (["delegate_task", "subagent", "spawn_subagent"].includes(normalized)) {
    return { kind: "delegation", label: "Delegated task" };
  }
  if (["todo", "plan", "update_plan"].includes(normalized)) {
    return { kind: "plan", label: "Update plan" };
  }
  if (/^(?:write|edit|patch|replace|apply)_?file$/.test(normalized) || normalized === "apply_patch") {
    return { kind: "file_change", label: "Update file" };
  }
  if (normalized.startsWith("mcp_") || normalized.includes("mcp")) {
    return { kind: "mcp_tool", label: "Use connected tool" };
  }
  if (normalized.includes("image") && (normalized.includes("inspect") || normalized.includes("analy"))) {
    return { kind: "image_inspection", label: "Inspect image" };
  }
  const safeWords = /^[a-z0-9_.:-]+$/.test(normalized)
    ? normalized.split(/[_.:-]+/).filter(Boolean).slice(0, 6).join(" ")
    : "";
  return { kind: "dynamic_tool", label: safeWords ? `Use ${safeWords}` : "Use tool" };
}

export function hermesActivitySummary(kind: HermesActivity["kind"], failed: boolean): string {
  if (kind === "command") return failed ? "Command failed." : "Command completed.";
  if (kind === "web_search") return failed ? "Web search failed." : "Web search completed.";
  if (kind === "delegation") return failed ? "Delegated work failed." : "Delegated work completed.";
  if (kind === "file_change") return failed ? "File update failed." : "File update completed.";
  return failed ? "Tool failed." : "Tool completed.";
}

export function hermesStatusActivity(kind: string): Pick<HermesActivity, "activityId" | "kind" | "label"> | undefined {
  const normalized = kind.trim().toLowerCase();
  if (["planning", "plan", "todo"].includes(normalized)) {
    return { activityId: "status_planning", kind: "plan", label: "Planning" };
  }
  if (["thinking", "reasoning"].includes(normalized)) {
    return { activityId: "status_reasoning", kind: "reasoning", label: "Analyzing" };
  }
  if (normalized === "compacting") {
    return { activityId: "status_compacting", kind: "phase", label: "Summarizing conversation" };
  }
  if (["process", "loop", "lifecycle"].includes(normalized)) {
    return { activityId: `status_${normalized}`, kind: "phase", label: "Working" };
  }
  if (["working", "work", "executing", "running"].includes(normalized)) {
    return { activityId: "status_working", kind: "phase", label: "Working" };
  }
  return undefined;
}

export function hermesToolFailed(result: unknown): boolean {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return false;
  const value = result as Record<string, unknown>;
  if (value.success === false || value.ok === false) return true;
  if (["error", "failed", "failure"].includes(String(value.status ?? "").toLowerCase())) return true;
  if (typeof value.exit_code === "number" && value.exit_code !== 0) return true;
  return value.error !== undefined
    && value.error !== null
    && value.error !== false
    && value.error !== "";
}
