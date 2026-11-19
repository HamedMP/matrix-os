import type { CanonicalChatRecord } from "@matrix-os/contracts";

import {
  resolveCanonicalChatAttention,
  resolveCanonicalChatLifecycleGroup,
  type CanonicalChatAttentionState,
} from "@/lib/shared-chat-state";
import type { StatusTone } from "@/components/ui/StatusDot";

export type ChatStatusState = Exclude<CanonicalChatAttentionState, "idle">;

/** What a chat row shows of a chat's state: a line of text and a dot. */
export interface ChatStatus {
  state: ChatStatusState;
  label: string;
  tone: StatusTone;
}

// Desktop's chat sidebar words and colours (work-rail/WorkRailChatRow.tsx):
// green while a run works, amber while the chat waits on the person, and the
// unread colour for a finished run nobody has read.
const STATUS: Record<ChatStatusState, Omit<ChatStatus, "state">> = {
  approval_required: { label: "Approval required", tone: "waiting" },
  input_required: { label: "Waiting for your reply", tone: "waiting" },
  running: { label: "Working…", tone: "active" },
  failed: { label: "Needs attention", tone: "waiting" },
  unseen_completion: { label: "Completed", tone: "unread" },
};

/** The chat's status, or null for a chat that is idle and read. */
export function chatStatus(record: CanonicalChatRecord): ChatStatus | null {
  const state = resolveCanonicalChatAttention(record);
  return state === "idle" ? null : { state, ...STATUS[state] };
}

/** Whether the chat waits on the person: an approval, an answer, or a failed run. */
export function chatNeedsUser(record: CanonicalChatRecord): boolean {
  return resolveCanonicalChatLifecycleGroup(record) === "needsYou";
}
