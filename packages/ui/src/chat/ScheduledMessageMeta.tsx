import { chatAgentMutedStyle } from "../chat-agents/theme.js";
import { scheduledMessageTime, type ScheduledMessagePresentation } from "./scheduled-message.js";

/** Shared Pi/native input annotation; keep the safe message body in its renderer. */
export function ScheduledMessageMeta({ timestamp, sent = true }: ScheduledMessagePresentation & { sent?: boolean }) {
  return <div data-scheduled-message className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xs" style={chatAgentMutedStyle}>
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l-3 2"/></svg>
    <span>{sent ? "Sent by scheduled task" : "Scheduled task"}</span>
    <time dateTime={timestamp}>{scheduledMessageTime(timestamp)}</time>
  </div>;
}
