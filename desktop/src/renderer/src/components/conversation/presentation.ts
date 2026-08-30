export type ConversationMessageRole = "user" | "assistant";

export interface ConversationAttachmentPresentation {
  id: string;
  label: string;
  kind: "file" | "resource" | "invocation";
}

export type ConversationMessageContentPresentation =
  | { kind: "text"; text: string }
  | { kind: "reference"; id: string; referenceKind: "file" | "resource" | "invocation"; label: string }
  | { kind: "image"; id: string; label: string; src: string };

export interface ConversationMessagePresentation {
  kind: "message";
  id: string;
  role: ConversationMessageRole;
  phase: "commentary" | "final";
  markdown: string;
  copyText: string;
  timestamp: number;
  content?: ConversationMessageContentPresentation[];
  /** @deprecated Use references for new provider-neutral projections. */
  attachments?: ConversationAttachmentPresentation[];
  references?: ConversationAttachmentPresentation[];
}

export type ConversationActionPresentation =
  | { kind: "retry"; turnId: string; label: string }
  | { kind: "approval"; requestId: string; decision: "approve" | "approve_for_session" | "decline" | "cancel"; label: string }
  | { kind: "input"; requestId: string; label: string };

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
  timestamp?: number;
  sequence?: number;
}

export interface ConversationNoticePresentation {
  kind: "notice";
  id: string;
  phase: "commentary" | "final";
  tone: "neutral" | "info" | "success" | "warning" | "stopped" | "failed";
  label: string;
  markdown: string;
  timestamp: number;
  actions?: ConversationActionPresentation[];
}

export interface ConversationRequestPresentation {
  kind: "request";
  id: string;
  phase: "commentary" | "final";
  requestKind: "approval" | "input";
  requestId: string;
  state: "waiting" | "resolved";
  label: string;
  detail?: string;
  risk?: "low" | "medium" | "high";
  timestamp: number;
  actions?: ConversationActionPresentation[];
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
  request: ConversationRequestPresentation;
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
  final?: ConversationMessagePresentation | ConversationNoticePresentation | ConversationRequestPresentation;
}

export interface ConversationPresentationCallbacks {
  copyText: (text: string) => Promise<void>;
  loadImage?: (src: string) => Promise<Blob>;
  performAction?: (action: ConversationActionPresentation, input?: string) => Promise<void>;
  canPerformAction?: (action: ConversationActionPresentation) => boolean;
  openFile?: (path: string) => boolean;
}
