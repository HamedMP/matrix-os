/**
 * The left rail: the unified inbox, then each account with its folder tree.
 * Folders show unread counts and accept dragged conversations.
 */
import { useState, type DragEvent, type ReactNode } from "react";
import { AlertCircle, Archive, File, Folder, Inbox, Send, ShieldAlert, Star, Trash2 } from "lucide-react";
import { Avatar, Badge, Skeleton } from "../../../_shared/office-ui";
import type { MailFolder, MailFolderRole } from "../../../_shared/office-accounts/types/mail";
import { selectFolderTree, selectInboxUnread, type AccountState, type FolderNode, type MailState, type ViewDescriptor } from "../model";
import { useMailUi } from "./context";
import { decodeThreadDrag, dropActionFor, performDrop, THREAD_DRAG_TYPE } from "./drag";

const ROLE_ICONS: Record<MailFolderRole, ReactNode> = {
  inbox: <Inbox size={15} />,
  starred: <Star size={15} />,
  drafts: <File size={15} />,
  sent: <Send size={15} />,
  archive: <Archive size={15} />,
  spam: <ShieldAlert size={15} />,
  trash: <Trash2 size={15} />,
  custom: <Folder size={15} />,
};

function isActive(state: MailState, descriptor: ViewDescriptor): boolean {
  const view = state.views[state.activeView]?.descriptor;
  if (!view || view.kind !== descriptor.kind) return false;
  if (view.kind === "unified" && descriptor.kind === "unified") return view.role === descriptor.role;
  if (view.kind === "folder" && descriptor.kind === "folder") return view.accountId === descriptor.accountId && view.folderId === descriptor.folderId;
  return false;
}

interface FolderRowProps {
  state: MailState;
  accountId: string;
  node: FolderNode;
}

function FolderRow({ state, accountId, node }: FolderRowProps) {
  const { store, dragKeys, notify } = useMailUi();
  const [over, setOver] = useState(false);
  const { folder } = node;
  const descriptor: ViewDescriptor = { kind: "folder", accountId, folderId: folder.id };
  // With one account the unified inbox is that account's inbox.
  const active = isActive(state, descriptor)
    || (state.accounts.length === 1 && folder.role !== "custom" && isActive(state, { kind: "unified", role: folder.role }));
  const unread = folder.unreadCount ?? 0;

  const accepts = () => dropActionFor(state, accountId, folder, dragKeys.current).kind !== "none";
  const onDragOver = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes(THREAD_DRAG_TYPE) || !accepts()) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (!over) setOver(true);
  };
  const onDrop = (event: DragEvent) => {
    setOver(false);
    const keys = decodeThreadDrag(event.dataTransfer.getData(THREAD_DRAG_TYPE));
    const action = dropActionFor(state, accountId, folder, keys);
    if (action.kind === "none") return;
    event.preventDefault();
    dragKeys.current = [];
    void performDrop(store, action, keys).then((ok) => {
      if (ok && action.kind === "move") notify(`Moved to ${folder.name}`, "success");
    });
  };

  return (
    <li>
      <button
        type="button"
        className={`mail-folder${active ? " is-active" : ""}${over ? " is-drop-target" : ""}`}
        style={{ paddingInlineStart: 10 + node.depth * 14 }}
        aria-current={active ? "page" : undefined}
        data-folder-id={folder.id}
        onClick={() => void store.openView(descriptor)}
        onDragOver={onDragOver}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <span className="mail-folder__icon" aria-hidden="true">{ROLE_ICONS[folder.role]}</span>
        <span className="mail-folder__name">{folder.name}</span>
        {unread > 0 && <span className="mail-folder__count" aria-label={`${unread} unread`}>{unread > 999 ? "999+" : unread}</span>}
      </button>
      {node.children.length > 0 && (
        <ul className="mail-folder-list">
          {node.children.map((child) => <FolderRow key={child.folder.id} state={state} accountId={accountId} node={child} />)}
        </ul>
      )}
    </li>
  );
}

function AccountSection({ state, entry }: { state: MailState; entry: AccountState }) {
  const { store } = useMailUi();
  const { account } = entry;
  const tree = selectFolderTree(state.folders[account.id]);
  const loading = entry.foldersStatus === "loading" && tree.length === 0;
  return (
    <section className="mail-account" aria-label={account.displayName}>
      <header className="mail-account__header">
        <Avatar name={account.displayName} size={22} />
        <span className="mail-account__name">
          <span className="mail-account__title">{account.displayName}</span>
          {account.displayName !== account.address && <span className="mail-account__address">{account.address}</span>}
        </span>
        <Badge>{account.provider === "gmail" ? "Gmail" : "Outlook"}</Badge>
      </header>
      {loading && <div className="mail-account__loading"><Skeleton lines={5} /></div>}
      {entry.foldersStatus === "error" && tree.length === 0 && (
        <div className="mail-pane-error" role="alert">
          <AlertCircle size={14} aria-hidden="true" />
          <span>{entry.foldersError?.message ?? "Folders could not be loaded."}</span>
          <button type="button" className="oui-button oui-button--ghost" onClick={() => void store.loadFolders(account.id)}>Retry</button>
        </div>
      )}
      {tree.length > 0 && (
        <ul className="mail-folder-list">
          {tree.map((node) => <FolderRow key={node.folder.id} state={state} accountId={account.id} node={node} />)}
        </ul>
      )}
    </section>
  );
}

export function FolderRail({ state }: { state: MailState }) {
  const { store } = useMailUi();
  const unified: ViewDescriptor = { kind: "unified", role: "inbox" };
  const unread = Object.values(selectInboxUnread(state)).reduce((sum, n) => sum + n, 0);
  const active = isActive(state, unified);
  return (
    <nav className="mail-rail" aria-label="Mailboxes">
      {state.accounts.length > 1 && (
        <button
          type="button"
          className={`mail-folder mail-folder--unified${active ? " is-active" : ""}`}
          aria-current={active ? "page" : undefined}
          onClick={() => void store.openView(unified)}
        >
          <span className="mail-folder__icon" aria-hidden="true"><Inbox size={15} /></span>
          <span className="mail-folder__name">All inboxes</span>
          {unread > 0 && <span className="mail-folder__count" aria-label={`${unread} unread`}>{unread > 999 ? "999+" : unread}</span>}
        </button>
      )}
      {state.accounts.map((entry) => <AccountSection key={entry.account.id} state={state} entry={entry} />)}
    </nav>
  );
}

/** Folders of one account a conversation can be moved to, for menus. */
export function moveTargets(folders: readonly MailFolder[] | undefined): MailFolder[] {
  return (folders ?? []).filter((folder) => !folder.virtual && folder.role !== "drafts" && folder.role !== "sent" && folder.role !== "spam");
}
