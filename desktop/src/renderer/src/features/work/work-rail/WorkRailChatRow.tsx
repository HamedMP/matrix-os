import type { CanonicalChatRecord } from "@matrix-os/contracts";
import {
  AlertCircle,
  LoaderCircle,
  MessageSquare,
  PinIcon,
  PinOffIcon,
  Trash2,
} from "@renderer/lib/hugeicons";
import { ContextMenu } from "../../../design/primitives";
import { OverflowingChatTitle } from "../OverflowingChatTitle";
import { ChatTitleEditor } from "../../chat/ChatTitleEditor";
import {
  resolveWorkRailAgentState,
  type WorkRailAgentState,
} from "../work-rail-model";

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
  onPin,
  onDelete,
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
  onPin: () => void;
  onDelete: () => void;
}) {
  const pinned = Boolean(record.chat.userState?.pinned);
  const agentState = resolveWorkRailAgentState(record);
  return (
    <ContextMenu items={[
      {
        label: "Rename",
        disabled: renameDisabled,
        onSelect: () => window.setTimeout(onRenameStart, 20),
      },
      {
        label: pinned ? "Unpin" : "Pin",
        disabled: pinning,
        onSelect: onPin,
      },
      {
        label: "Delete",
        danger: true,
        onSelect: onDelete,
      },
    ]}>
      <div
        data-placement={placement}
        className="group/chat relative flex min-w-0 items-center rounded-md transition-colors duration-100 hover:bg-[var(--bg-hover)] focus-within:bg-[var(--bg-hover)]"
        style={{ background: active ? "var(--bg-selected)" : undefined }}
      >
        {renaming ? (
          <div className="flex w-full min-w-0 items-center gap-2.5 px-2.5 py-1.5 text-sm font-medium">
            <MessageSquare size={15} aria-hidden className="shrink-0" style={{ color: active ? "var(--accent)" : "var(--text-tertiary)" }} />
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
          className="flex w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
          style={{ color: active ? "var(--text-primary)" : "var(--text-secondary)" }}
          onClick={onSelect}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!renameDisabled) window.setTimeout(onRenameStart, 0);
          }}
        >
          <MessageSquare size={15} aria-hidden className="shrink-0" style={{ color: active ? "var(--accent)" : "var(--text-tertiary)" }} />
          <OverflowingChatTitle title={record.chat.title} />
          <ChatAgentStateIndicator state={agentState} title={record.chat.title} />
        </button>}
        {!renaming ? <div
          className="pointer-events-none absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 rounded-md opacity-0 transition-opacity group-hover/chat:pointer-events-auto group-hover/chat:opacity-100 group-focus-within/chat:pointer-events-auto group-focus-within/chat:opacity-100"
          style={{
            background: active
              ? "linear-gradient(var(--bg-selected), var(--bg-selected)), var(--bg-surface)"
              : "linear-gradient(var(--bg-hover), var(--bg-hover)), var(--bg-surface)",
          }}
        >
          <button
            type="button"
            aria-label={`${pinned ? "Unpin" : "Pin"} ${record.chat.title}`}
            title={`${pinned ? "Unpin" : "Pin"} ${record.chat.title}`}
            disabled={pinning}
            className="flex size-6 shrink-0 items-center justify-center rounded-md outline-none hover:bg-[var(--bg-selected)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            onClick={onPin}
          >
            {pinned
              ? <PinOffIcon size={13} aria-hidden />
              : <PinIcon size={13} aria-hidden />}
          </button>
          <button
            type="button"
            aria-label={`Delete ${record.chat.title}`}
            title={`Delete ${record.chat.title}`}
            className="flex size-6 shrink-0 items-center justify-center rounded-md outline-none hover:bg-[var(--danger-muted)] hover:text-[var(--danger)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            onClick={onDelete}
          >
            <Trash2 size={13} aria-hidden />
          </button>
        </div> : null}
      </div>
    </ContextMenu>
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
  if (state === "running") {
    return (
      <LoaderCircle
        aria-label={`Agent running for ${title}`}
        className="ml-auto shrink-0 animate-spin"
        size={13}
      />
    );
  }
  const requiresApproval = state === "approval_required";
  const label = requiresApproval
    ? `Approval required for ${title}`
    : state === "input_required"
      ? `Input required for ${title}`
      : `Agent failed for ${title}`;
  return (
    <AlertCircle
      aria-label={label}
      className="ml-auto shrink-0"
      size={13}
      style={{ color: state === "failed" ? "var(--danger)" : "var(--warning)" }}
    />
  );
}
