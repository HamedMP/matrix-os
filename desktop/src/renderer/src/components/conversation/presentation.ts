export type ConversationMessageRole = "user" | "assistant";

export interface ConversationAttachmentPresentation {
  id: string;
  label: string;
  kind: "file";
}

export interface ConversationMessagePresentation {
  kind: "message";
  id: string;
  role: ConversationMessageRole;
  phase: "commentary" | "final";
  markdown: string;
  copyText: string;
  timestamp: number;
  attachments?: ConversationAttachmentPresentation[];
}

export type ConversationActivityKind =
  | "phase"
  | "reasoning"
  | "plan"
  | "command"
  | "file_change"
  | "mcp_tool"
  | "dynamic_tool"
  | "delegation"
  | "web_search"
  | "image_inspection"
  | "read"
  | "edit"
  | "search"
  | "tool";
export type ConversationActivityState = "running" | "completed" | "partial" | "stopped" | "failed";

export interface ConversationActivityPresentation {
  id: string;
  kind: ConversationActivityKind;
  state: ConversationActivityState;
  label: string;
  preview?: string;
  previewKind?: "command" | "path" | "text";
  copyText?: string;
  detail?: string;
}

export interface ConversationActivityGroupPresentation {
  kind: "activity-group";
  id: string;
  activities: ConversationActivityPresentation[];
}

export interface ConversationNoticePresentation {
  kind: "notice";
  id: string;
  phase: "commentary" | "final";
  tone: "neutral" | "stopped" | "failed";
  label: string;
  markdown: string;
  timestamp: number;
}

/**
 * The single registry for provider-neutral transcript rows. MAT-458 can add
 * reasoning, plan, delegation, approval, and user-input variants here and in
 * the shared renderer without creating provider-owned visual components.
 */
export interface ConversationWorkPresentationMap {
  message: ConversationMessagePresentation;
  "activity-group": ConversationActivityGroupPresentation;
  notice: ConversationNoticePresentation;
}

export type ConversationWorkPresentation =
  ConversationWorkPresentationMap[keyof ConversationWorkPresentationMap];

export interface ConversationTurnPresentation {
  id: string;
  startedAt: number;
  endedAt: number;
  active: boolean;
  user?: ConversationMessagePresentation;
  work: ConversationWorkPresentation[];
  final?: ConversationMessagePresentation | ConversationNoticePresentation;
}

export interface ConversationPresentationCallbacks {
  copyText: (text: string) => Promise<void>;
}
