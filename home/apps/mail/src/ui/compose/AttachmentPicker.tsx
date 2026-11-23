/**
 * Picks a file from the owner's home through `MatrixOS.files` and attaches
 * it. Folders open in place; documents made in Docs and Sheets are labelled.
 * The size is checked before the file is read (see `compose/attachments`).
 */
import { useEffect, useState } from "react";
import { ChevronRight, File, FileSpreadsheet, FileText, Folder, Home } from "lucide-react";
import { Dialog, EmptyState, Spinner } from "../../../../_shared/office-ui";
import type { Draft, DraftAttachment } from "../../../../_shared/office-accounts/types/mail";
import {
  ATTACH_ERROR_MESSAGES,
  ComposeAttachError,
  attachmentRoom,
  fileKindLabel,
  formatBytes,
  readAttachment,
  type PickerFiles,
} from "../../compose/attachments";

export interface AttachmentPickerProps {
  open: boolean;
  files: PickerFiles;
  /** The draft as it would be saved (quote included), for the size budget. */
  draft: Draft;
  onClose(): void;
  onAttach(attachment: DraftAttachment): void;
  onBusy(busy: boolean): void;
}

type Entry = Awaited<ReturnType<PickerFiles["list"]>>["entries"][number];

function iconFor(entry: Entry) {
  if (entry.kind === "dir") return <Folder size={15} aria-hidden="true" />;
  const label = fileKindLabel(entry.name);
  if (label === "Docs document") return <FileText size={15} aria-hidden="true" />;
  if (label === "Sheets workbook") return <FileSpreadsheet size={15} aria-hidden="true" />;
  return <File size={15} aria-hidden="true" />;
}

export function AttachmentPicker({ open, files, draft, onClose, onAttach, onBusy }: AttachmentPickerProps) {
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const room = attachmentRoom(draft, "attachment");

  useEffect(() => {
    if (!open) return;
    let live = true;
    setEntries(null);
    setError(null);
    files.list(dir, { limit: 500 }).then(
      (listing) => {
        if (!live) return;
        setEntries(listing.entries);
        setTruncated(listing.truncated);
      },
      (failure: unknown) => {
        console.warn(`[mail] attach.list.failed (${failure instanceof Error ? failure.name : typeof failure})`);
        if (live) {
          setEntries([]);
          setError(ATTACH_ERROR_MESSAGES.unavailable);
        }
      },
    );
    return () => {
      live = false;
    };
  }, [open, dir, files]);

  const pick = async (entry: Entry) => {
    if (entry.kind === "dir") {
      setDir(entry.path);
      return;
    }
    setError(null);
    setReading(entry.path);
    onBusy(true);
    try {
      onAttach(await readAttachment(files, entry.path, draft));
      onClose();
    } catch (failure: unknown) {
      setError(failure instanceof ComposeAttachError ? failure.message : ATTACH_ERROR_MESSAGES.unavailable);
      if (!(failure instanceof ComposeAttachError)) console.warn(`[mail] attach.failed (${failure instanceof Error ? failure.name : typeof failure})`);
    } finally {
      setReading(null);
      onBusy(false);
    }
  };

  const crumbs = dir ? dir.split("/") : [];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Attach a file"
      description={room > 0 ? `Files up to ${formatBytes(room)} can be attached to this message.` : "This message has no room for another attachment."}
      size="md"
    >
      <nav className="mail-compose-picker__crumbs" aria-label="Folder">
        <button type="button" className="oui-button oui-button--ghost" onClick={() => setDir("")}><Home size={14} aria-hidden="true" /> Home</button>
        {crumbs.map((part, index) => (
          <span key={crumbs.slice(0, index + 1).join("/")} className="mail-compose-picker__crumb">
            <ChevronRight size={12} aria-hidden="true" />
            <button type="button" className="oui-button oui-button--ghost" onClick={() => setDir(crumbs.slice(0, index + 1).join("/"))}>{part}</button>
          </span>
        ))}
      </nav>
      {error && <p className="mail-compose__error" role="alert">{error}</p>}
      {entries === null ? (
        <div className="mail-compose-picker__loading"><Spinner label="Loading files" /></div>
      ) : entries.length === 0 && !error ? (
        <EmptyState icon={<Folder />} headline="This folder is empty" description="Choose another folder." />
      ) : (
        <ul className="mail-compose-picker__list" aria-label="Files">
          {entries.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                className="mail-compose-picker__entry"
                disabled={reading !== null}
                aria-label={entry.kind === "dir" ? `Open folder ${entry.name}` : `Attach ${entry.name}`}
                onClick={() => void pick(entry)}
              >
                {iconFor(entry)}
                <span className="mail-compose-picker__name">{entry.name}</span>
                {entry.kind === "file" && <span className="mail-compose-picker__meta">{fileKindLabel(entry.name)} · {formatBytes(entry.size)}</span>}
                {reading === entry.path && <Spinner size={14} label="Reading file" />}
              </button>
            </li>
          ))}
        </ul>
      )}
      {truncated && <p className="mail-compose__hint">Only the first 500 items are shown.</p>}
    </Dialog>
  );
}
