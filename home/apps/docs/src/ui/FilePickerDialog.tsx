/**
 * The Open dialog: browses the owner's home through `MatrixOS.files.list`
 * and shows folders and `.docx` files only. Single click selects, double
 * click or Open opens.
 */

import { ChevronRight, FileText, Folder, FolderUp } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { BridgeFileEntry, MatrixOSFiles } from "../../../_shared/matrix-os";
import { Dialog, Spinner } from "../../../_shared/office-ui";
import { isBridgeFileError } from "../session/index";
import { breadcrumbs, parentOf, pickerEntries } from "./file-picker-model";

export interface FilePickerDialogProps {
  open: boolean;
  files: Pick<MatrixOSFiles, "list">;
  title?: string;
  onClose: () => void;
  onPick: (path: string) => void;
}

type Listing = { status: "loading" } | { status: "ready"; entries: BridgeFileEntry[]; truncated: boolean } | { status: "error"; message: string };

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function listingError(error: unknown): string {
  if (isBridgeFileError(error, "forbidden")) return "Docs is not allowed to look in this folder.";
  if (isBridgeFileError(error, "not_found")) return "This folder no longer exists.";
  return "This folder could not be listed. Try again in a moment.";
}

function modified(entry: BridgeFileEntry): string {
  const time = Date.parse(entry.modifiedAt);
  return Number.isNaN(time) ? "" : DATE_FORMAT.format(time);
}

export function FilePickerDialog({ open, files, title = "Open a document", onClose, onPick }: FilePickerDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title={title} description="Folders and Word documents in your home." size="lg">
      {open && <PickerBody files={files} onClose={onClose} onPick={onPick} />}
    </Dialog>
  );
}

function PickerBody({ files, onClose, onPick }: Omit<FilePickerDialogProps, "open" | "title">) {
  const [dir, setDir] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [listing, setListing] = useState<Listing>({ status: "loading" });
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setListing({ status: "loading" });
    setSelected(null);
    files.list(dir).then(
      (result) => {
        if (live) setListing({ status: "ready", entries: pickerEntries(dir, result.entries), truncated: result.truncated });
      },
      (error: unknown) => {
        console.warn("docs: could not list a folder", error);
        if (live) setListing({ status: "error", message: listingError(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [files, dir, attempt]);

  const choose = useCallback(
    (path: string) => {
      onPick(path);
      onClose();
    },
    [onPick, onClose],
  );

  const crumbs = breadcrumbs(dir);
  return (
    <div className="docs-picker">
      <nav className="docs-picker__crumbs" aria-label="Folder path">
        {dir !== "" && (
          <button type="button" className="oui-icon-button" aria-label="Up one folder" title="Up one folder" onClick={() => setDir(parentOf(dir))}>
            <FolderUp size={16} aria-hidden="true" />
          </button>
        )}
        {crumbs.map((crumb, index) => (
          <span key={crumb.path} className="docs-picker__crumb">
            {index > 0 && <ChevronRight size={14} aria-hidden="true" />}
            <button type="button" className="oui-button oui-button--ghost" aria-current={index === crumbs.length - 1 ? "location" : undefined} onClick={() => setDir(crumb.path)}>
              {crumb.label}
            </button>
          </span>
        ))}
      </nav>
      <div className="docs-picker__list">
        {listing.status === "loading" && <Spinner label="Loading folder" />}
        {listing.status === "error" && (
          <div role="alert" className="docs-inline-alert">
            <span>{listing.message}</span>
            <button type="button" className="oui-button" onClick={() => setAttempt((value) => value + 1)}>
              Try again
            </button>
          </div>
        )}
        {listing.status === "ready" && listing.entries.length === 0 && <p className="docs-muted">No folders or Word documents here.</p>}
        {listing.status === "ready" && (
          <ul className="docs-picker__entries">
            {listing.entries.map((entry) => (
              <li key={entry.path}>
                {entry.kind === "dir" ? (
                  <button type="button" className="docs-picker__entry" aria-label={`Folder ${entry.name}`} onClick={() => setDir(entry.path)}>
                    <Folder size={16} aria-hidden="true" />
                    <span className="docs-picker__name">{entry.name}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="docs-picker__entry"
                    aria-pressed={selected === entry.path}
                    aria-label={`Document ${entry.name}`}
                    onClick={() => setSelected(entry.path)}
                    onDoubleClick={() => choose(entry.path)}
                  >
                    <FileText size={16} aria-hidden="true" />
                    <span className="docs-picker__name">{entry.name}</span>
                    <span className="docs-muted">{modified(entry)}</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {listing.status === "ready" && listing.truncated && <p className="docs-muted">Only the first 500 entries are shown.</p>}
      </div>
      <div className="oui-dialog__footer docs-picker__footer">
        <button type="button" className="oui-button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="oui-button oui-button--primary" disabled={selected === null} onClick={() => selected !== null && choose(selected)}>
          Open
        </button>
      </div>
    </div>
  );
}
