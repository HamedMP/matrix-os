/**
 * The list header: a select-all checkbox, and once conversations are selected
 * the bulk actions (archive, move, mark read or unread, flag, trash).
 */
import { useEffect, useRef } from "react";
import { Archive, Flag, FlagOff, FolderInput, MailCheck, MailOpen, Trash2, X } from "lucide-react";
import { Dropdown } from "../../../_shared/office-ui";
import type { MailState, ThreadKey } from "../model";
import { useMailUi } from "./context";
import { moveTargets } from "./FolderRail";

export interface BulkBarProps {
  state: MailState;
  visible: readonly ThreadKey[];
}

function SelectAll({ checked, mixed, onToggle }: { checked: boolean; mixed: boolean; onToggle: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="oui-checkbox__input"
      aria-label={checked ? "Clear selection" : "Select all conversations"}
      aria-checked={mixed ? "mixed" : checked}
      checked={checked}
      onChange={onToggle}
    />
  );
}

export function BulkBar({ state, visible }: BulkBarProps) {
  const { store } = useMailUi();
  const keys = state.selection.keys;
  const count = keys.length;
  const allSelected = visible.length > 0 && visible.every((key) => keys.includes(key));
  const toggleAll = () => (allSelected || count > 0 ? store.clearSelection() : store.selectAllVisible());

  if (count === 0) {
    return (
      <div className="mail-bulk" role="toolbar" aria-label="List actions">
        <SelectAll checked={false} mixed={false} onToggle={toggleAll} />
        <span className="mail-bulk__summary">{visible.length === 1 ? "1 conversation" : `${visible.length} conversations`}</span>
      </div>
    );
  }

  const summaries = keys.map((key) => state.threads[key]).filter(Boolean);
  const accounts = new Set(summaries.map((summary) => summary.accountId));
  const accountId = accounts.size === 1 ? [...accounts][0] : null;
  const targets = accountId ? moveTargets(state.folders[accountId]) : [];
  const allFlagged = summaries.length > 0 && summaries.every((summary) => summary.flagged);
  const anyUnread = summaries.some((summary) => summary.unread);

  return (
    <div className="mail-bulk is-active" role="toolbar" aria-label="Bulk actions">
      <SelectAll checked={allSelected} mixed={!allSelected} onToggle={toggleAll} />
      <span className="mail-bulk__summary" aria-live="polite">{count} selected</span>
      <button type="button" className="oui-icon-button" aria-label="Archive selected" title="Archive" onClick={() => void store.archive()}><Archive size={15} /></button>
      <Dropdown
        label={<FolderInput size={15} />}
        ariaLabel="Move selected to folder"
        disabled={targets.length === 0}
        items={targets.map((folder) => ({ id: folder.id, label: folder.name }))}
        onSelect={(folderId) => void store.moveTo(folderId)}
      />
      {anyUnread
        ? <button type="button" className="oui-icon-button" aria-label="Mark selected as read" title="Mark as read" onClick={() => void store.markRead(true)}><MailCheck size={15} /></button>
        : <button type="button" className="oui-icon-button" aria-label="Mark selected as unread" title="Mark as unread" onClick={() => void store.markRead(false)}><MailOpen size={15} /></button>}
      {allFlagged
        ? <button type="button" className="oui-icon-button" aria-label="Unflag selected" title="Unflag" onClick={() => void store.setFlag(false)}><FlagOff size={15} /></button>
        : <button type="button" className="oui-icon-button" aria-label="Flag selected" title="Flag" onClick={() => void store.setFlag(true)}><Flag size={15} /></button>}
      <button type="button" className="oui-icon-button" aria-label="Move selected to trash" title="Move to trash" onClick={() => void store.trash()}><Trash2 size={15} /></button>
      <span className="mail-bulk__spacer" />
      <button type="button" className="oui-icon-button" aria-label="Clear selection" title="Clear selection" onClick={() => store.clearSelection()}><X size={15} /></button>
    </div>
  );
}
