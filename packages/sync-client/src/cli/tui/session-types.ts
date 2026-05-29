export type MatrixSessionKind = "shell" | "agent" | "review" | "task";

export interface MatrixSessionSummary {
  id: string;
  kind: MatrixSessionKind;
  name: string;
  status: string;
  context?: string;
  projectSlug?: string;
  worktreeId?: string;
  taskId?: string;
  agent?: string;
  attention?: "ready" | "busy" | "blocked" | "unknown";
  nativeAttachCommand?: string[];
  timeline?: Array<{ timestamp?: string; summary: string }>;
}

export interface ShellRuntimeTab {
  index: number;
  name?: string;
}

export interface ShellRuntimePane {
  id: string;
  title?: string;
}
