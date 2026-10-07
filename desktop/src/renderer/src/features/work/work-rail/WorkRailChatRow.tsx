import type { CanonicalChatRecord } from "@matrix-os/contracts";
import {
  MessageSquare,
  PinIcon,
  PinOffIcon,
} from "lucide-react";
import { isChatUnread, ChatContextMenu } from "@matrix-os/ui";
import { OverflowingChatTitle } from "../OverflowingChatTitle";
import { ChatTitleEditor } from "../../chat/ChatTitleEditor";
import {
  resolveWorkRailAgentState,
  type WorkRailAgentState,
} from "../work-rail-model";
import { WorkRailChatMenu, type RailChatAction } from "./WorkRailChatMenu";
import { useEffect, useRef, useState } from "react";

const railStateLabel: Record<Exclude<WorkRailAgentState, "idle">, string> = {
  approval_required: "Approval required",
  input_required: "Waiting for your reply",
  running: "Working…",
  failed: "Needs attention",
  unseen_completion: "Completed",
};

export function WorkRailChatRow({
  record,
  active,
  pinning,
  placement,
  onSelect,
  renaming,
  renamePending,
  renameDisabled,
  onRenameStart,
  onRenameCommit,
  onRenameCancel,
  onToggleRead,
  readPending = false,
  onPin,
  onDelete,
  moveItems,
  moving = false,
}: {
  record: CanonicalChatRecord;
  active: boolean;
  pinning: boolean;
  placement: "pinned" | "project" | "recent";
  onSelect: () => void;
  renaming: boolean;
  renamePending: boolean;
  renameDisabled: boolean;
  onRenameStart: () => void;
  onRenameCommit: (title: string) => void;
  onRenameCancel: () => void;
  onToggleRead?: () => void;
  readPending?: boolean;
  onPin: () => void;
  onDelete: () => void;
  moveItems?: {label: string; disabled?: boolean; onSelect: () => void}[];
  moving?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const selectTimerRef = useRef<number | null>(null);
  const renameTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (selectTimerRef.current !== null) window.clearTimeout(selectTimerRef.current);
    if (renameTimerRef.current !== null) window.clearTimeout(renameTimerRef.current);
  }, []);
  const scheduleRename = (delay: number) => {
    if (renameTimerRef.current !== null) window.clearTimeout(renameTimerRef.current);
    renameTimerRef.current = window.setTimeout(() => {
      renameTimerRef.current = null;
      onRenameStart();
    }, delay);
  };
  const pinned = Boolean(record.chat.userState?.pinned);
  const agentState = resolveWorkRailAgentState(record);
  const menuItems: RailChatAction[] = [
    { label: pinned ? "Unpin" : "Pin", disabled: pinning, onSelect: onPin },
    { label: "Rename", disabled: renameDisabled, onSelect: () => scheduleRename(20) },
    ...(moveItems ? [{ label: "Move to project", disabled: moving || Boolean(record.activeRun), children: moveItems }] : []),
    { label: "Delete", danger: true, onSelect: onDelete },
  ];
  return (
    <ChatContextMenu chatId={record.chat.id} primaryAction={onToggleRead ? { label: isChatUnread(record) ? "Mark as read" : "Mark as unread", disabled: readPending, onSelect: onToggleRead } : undefined} items={menuItems}>
      <div
        data-chat-title-row
        data-placement={placement}
        data-current={active || undefined}
        data-two-line={agentState !== "idle" || undefined}
        data-menu-open={menuOpen || undefined}
        className="work-rail-chat group/chat relative flex min-w-0 items-center"
      >
        {renaming ? (
          <div className={`flex w-full min-w-0 items-center gap-2.5 px-2.5 py-1.5 text-sm font-normal ${placement === "project" ? "pl-[24px]" : ""}`}>
            <MessageSquare size={15} aria-hidden className="shrink-0" style={{ color: "var(--matrix-chat-rail-text, var(--text-primary))" }} />
            <ChatTitleEditor
              title={record.chat.title}
              disabled={renamePending}
              className="w-full"
              onCommit={onRenameCommit}
              onCancel={onRenameCancel}
            />
          </div>
        ) : <button
          type="button"
          aria-label={record.chat.title}
          aria-current={active ? "page" : undefined}
          className={`flex w-full min-w-0 items-center gap-2.5 rounded-[8px] px-2.5 py-1.5 text-left text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)] ${placement === "project" ? "pl-[24px]" : ""}`}
          style={{ color: "var(--matrix-chat-rail-text, var(--text-primary))" }}
          onClick={(event) => {
            if (event.detail === 0) {
              onSelect();
              return;
            }
            if (selectTimerRef.current !== null) window.clearTimeout(selectTimerRef.current);
            selectTimerRef.current = window.setTimeout(() => {
              selectTimerRef.current = null;
              onSelect();
            }, 250);
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (selectTimerRef.current !== null) {
              window.clearTimeout(selectTimerRef.current);
              selectTimerRef.current = null;
            }
            if (!renameDisabled) scheduleRename(0);
          }}
        >
          <MessageSquare size={15} aria-hidden className="shrink-0" style={{ color: "var(--matrix-chat-rail-text, var(--text-primary))" }} />
          <span className="work-rail-chat-label min-w-0 flex-1">
            <span className={isChatUnread(record) ? "flex min-w-0 font-semibold" : "flex min-w-0"}><OverflowingChatTitle title={record.chat.title} /></span>
            {agentState !== "idle" ? <span className="block text-[11px] leading-[14.3px] font-normal" style={{ color: "var(--matrix-chat-rail-muted, var(--text-secondary))" }}>{railStateLabel[agentState]}</span> : null}
          </span>
          {isChatUnread(record) && (record.readState || agentState !== "unseen_completion") ? <span aria-label={`Unread ${record.chat.title}`} className="size-2 shrink-0 rounded-full bg-[var(--accent)]" /> : null}
          <ChatAgentStateIndicator state={record.readState && agentState === "unseen_completion" ? "idle" : agentState} title={record.chat.title} />
        </button>}
        {!renaming ? <div
          className="work-rail-chat-actions pointer-events-none absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 rounded-[8px] opacity-0 transition-opacity group-hover/chat:pointer-events-auto group-hover/chat:opacity-100 group-focus-within/chat:pointer-events-auto group-focus-within/chat:opacity-100"
        >
          <button
            type="button"
            aria-label={`${pinned ? "Unpin" : "Pin"} ${record.chat.title}`}
            title={`${pinned ? "Unpin" : "Pin"} ${record.chat.title}`}
            disabled={pinning}
            className="flex size-6 shrink-0 items-center justify-center rounded-[8px] outline-none hover:bg-[var(--matrix-chat-rail-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            onClick={onPin}
          >
            {pinned
              ? <PinOffIcon size={13} aria-hidden />
              : <PinIcon size={13} aria-hidden />}
          </button>
          <WorkRailChatMenu title={record.chat.title} items={menuItems} open={menuOpen} onOpenChange={setMenuOpen} />
        </div> : null}
      </div>
    </ChatContextMenu>
  );
}

function ChatAgentStateIndicator({
  state,
  title,
}: {
  state: WorkRailAgentState;
  title: string;
}) {
  if (state === "idle") return null;
  if (state === "unseen_completion") {
    return (
      <span
        aria-label={`Unseen completion for ${title}`}
        className="ml-auto size-2 shrink-0 rounded-full bg-[var(--accent)]"
      />
    );
  }
  const label = state === "running"
    ? `Agent running for ${title}`
    : state === "approval_required"
      ? `Approval required for ${title}`
      : state === "input_required"
        ? `Input required for ${title}`
        : `Agent failed for ${title}`;
  return <span aria-label={label} className="ml-auto size-[6px] shrink-0 rounded-full"
    style={{ background: state === "running" ? "var(--matrix-chat-rail-success, var(--success))" : "var(--matrix-chat-rail-warning, var(--warning))" }} />;
}
