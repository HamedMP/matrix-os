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

export type ConversationActivityKind = "command" | "read" | "edit" | "search" | "tool";
export type ConversationActivityState = "running" | "completed" | "stopped" | "failed";

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

export type ConversationWorkPresentation =
  | ConversationMessagePresentation
  | ConversationActivityGroupPresentation
  | ConversationNoticePresentation;

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

export interface ConversationProviderOption {
  id: string;
  label: string;
  available: boolean;
}
