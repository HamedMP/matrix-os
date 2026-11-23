import { ChatTitleEditor } from "../chat/ChatTitleEditor";

/** Shared title presentation for the Work surface's existing rename workflow. */
export function WorkChatTitle({ title, shared, editing, renaming, onCommit, onCancel, onEdit }: {
  title: string;
  shared: boolean;
  editing: boolean;
  renaming: boolean;
  onCommit(title: string): void;
  onCancel(): void;
  onEdit(): void;
}) {
  if (shared) return <span className="block min-w-0 max-w-full truncate" title={title}>{title}</span>;
  if (editing) return <ChatTitleEditor title={title} disabled={renaming}
    className="w-[min(360px,40vw)] max-w-full" onCommit={onCommit} onCancel={onCancel} />;
  return <button type="button" aria-label={`Rename ${title}`} title={title}
    className="no-drag pointer-events-auto min-w-0 max-w-full truncate rounded px-1.5 py-0.5 text-left outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
    onClick={onEdit}>{title}</button>;
}
