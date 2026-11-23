/** Browses the home folder for .xlsx, .csv and .tsv files. */
import { ChevronRight, FileSpreadsheet, Folder } from "lucide-react";
import { useEffect, useState } from "react";
import { Dialog, EmptyState, Spinner } from "../../../_shared/office-ui";
import type { BridgeFileEntry } from "../../../_shared/matrix-os";
import { pickable } from "./file-picker-model";
import { logFailure, type SheetsBridge } from "./bridge";

export interface FilePickerProps {
  open: boolean;
  files: SheetsBridge["files"];
  onCancel: () => void;
  onPick: (path: string) => void;
}

type Listing = { status: "loading" } | { status: "ready"; entries: BridgeFileEntry[]; truncated: boolean } | { status: "error"; message: string };

function listingMessage(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : null;
  if (code === "forbidden") return "Sheets may not look in this folder.";
  if (code === "not_found") return "This folder no longer exists.";
  return "The folder could not be read. Try again.";
}

function crumbs(dir: string): Array<{ label: string; path: string }> {
  const out = [{ label: "Home", path: "" }];
  if (dir === "") return out;
  const parts = dir.split("/");
  parts.forEach((part, index) => out.push({ label: part, path: parts.slice(0, index + 1).join("/") }));
  return out;
}

function PickerBody({ files, onPick }: Pick<FilePickerProps, "files" | "onPick">) {
  const [dir, setDir] = useState("");
  const [listing, setListing] = useState<Listing>({ status: "loading" });

  useEffect(() => {
    let live = true;
    files.list(dir).then(
      (result) => {
        if (live) setListing({ status: "ready", entries: pickable(result.entries), truncated: result.truncated });
      },
      (error: unknown) => {
        logFailure("folder listing failed", error);
        if (live) setListing({ status: "error", message: listingMessage(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [files, dir]);

  const goTo = (path: string): void => {
    setListing({ status: "loading" });
    setDir(path);
  };

  return (
    <div className="sheets-picker">
      <nav aria-label="Folder path" className="sheets-picker__crumbs">
        {crumbs(dir).map((crumb, index, all) => (
          <span key={crumb.path} className="sheets-picker__crumb">
            {index > 0 && <ChevronRight size={14} aria-hidden="true" />}
            {index === all.length - 1 ? (
              <span aria-current="location">{crumb.label}</span>
            ) : (
              <button type="button" className="sheets-link" onClick={() => goTo(crumb.path)}>
                {crumb.label}
              </button>
            )}
          </span>
        ))}
      </nav>
      <div className="sheets-picker__list">
        {listing.status === "loading" && <Spinner label="Loading folder" />}
        {listing.status === "error" && <p className="sheets-picker__error" role="alert">{listing.message}</p>}
        {listing.status === "ready" && listing.entries.length === 0 && (
          <EmptyState icon={<FileSpreadsheet />} headline="No spreadsheets here" description="This folder has no .xlsx, .csv or .tsv files." />
        )}
        {listing.status === "ready" && (
          <ul aria-label="Files and folders">
            {listing.entries.map((entry) => (
              <li key={entry.path}>
                <button type="button" className="sheets-picker__entry" onClick={() => (entry.kind === "dir" ? goTo(entry.path) : onPick(entry.path))}>
                  {entry.kind === "dir" ? <Folder size={16} aria-hidden="true" /> : <FileSpreadsheet size={16} aria-hidden="true" />}
                  <span>{entry.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {listing.status === "ready" && listing.truncated && <p className="sheets-picker__note">This folder holds more entries than can be shown.</p>}
      </div>
    </div>
  );
}

export function FilePicker({ open, files, onCancel, onPick }: FilePickerProps) {
  return (
    <Dialog open={open} onClose={onCancel} title="Open a spreadsheet" description="Choose an .xlsx, .csv or .tsv file from your home." size="md">
      {open && <PickerBody files={files} onPick={onPick} />}
    </Dialog>
  );
}
