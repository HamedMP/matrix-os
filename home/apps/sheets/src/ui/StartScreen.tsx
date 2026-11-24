/** What Sheets shows with no workbook open: recent files and ways to start. */
import { ClipboardPaste, FileSpreadsheet, FolderOpen, Laptop, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { EmptyState, Spinner } from "../../../_shared/office-ui";
import type { RecentFile, RecentFiles } from "../session";

/** The launcher artwork, shown where the app introduces itself. */
const appArtwork = new URL("../../../../system/icons/v3-sheets.png", import.meta.url).href;

export interface StartScreenProps {
  recents: RecentFiles;
  /** Path being opened, shown as busy. */
  opening: string | null;
  onNew: () => void;
  onOpen: () => void;
  /** Opens the system file chooser. */
  onOpenLocal: () => void;
  onImport: () => void;
  onOpenPath: (path: string) => void;
}

function folderOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "Home" : path.slice(0, at);
}

function when(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  return new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function StartScreen({ recents, opening, onNew, onOpen, onOpenLocal, onImport, onOpenPath }: StartScreenProps) {
  const [files, setFiles] = useState<RecentFile[] | null>(null);

  useEffect(() => {
    let live = true;
    // `list()` never rejects: it logs and returns an empty list.
    void recents.list().then((list) => {
      if (live) setFiles(list);
    });
    return () => {
      live = false;
    };
  }, [recents]);

  return (
    <div className="sheets-start">
      <section className="sheets-start__actions" aria-label="Start">
        <button type="button" className="sheets-start__card" onClick={onNew}>
          <Plus size={22} aria-hidden="true" />
          <span className="sheets-start__card-title">New blank workbook</span>
        </button>
        <button type="button" className="sheets-start__card" onClick={onOpen}>
          <FolderOpen size={22} aria-hidden="true" />
          <span className="sheets-start__card-title">Open from Matrix</span>
          <span className="sheets-start__card-hint">.xlsx, .csv or .tsv from your home</span>
        </button>
        <button type="button" className="sheets-start__card" onClick={onOpenLocal}>
          <Laptop size={22} aria-hidden="true" />
          <span className="sheets-start__card-title">Open from this computer</span>
          <span className="sheets-start__card-hint">Or drop a file on this window</span>
        </button>
        <button type="button" className="sheets-start__card" onClick={onImport}>
          <ClipboardPaste size={22} aria-hidden="true" />
          <span className="sheets-start__card-title">Import CSV</span>
          <span className="sheets-start__card-hint">Paste rows of text</span>
        </button>
      </section>
      <section className="sheets-start__recent" aria-labelledby="sheets-recent-heading">
        <h2 id="sheets-recent-heading">Recent workbooks</h2>
        {files === null && <Spinner label="Loading recent workbooks" />}
        {files !== null && files.length === 0 && (
          <EmptyState icon={<img className="oui-empty__artwork" src={appArtwork} alt="" width={80} height={80} draggable={false} />} headline="No recent workbooks" description="Workbooks you open or save appear here. Open one from Files or start a new one." />
        )}
        {files !== null && files.length > 0 && (
          <ul className="sheets-start__list">
            {files.map((file) => (
              <li key={file.path}>
                <button type="button" className="sheets-start__file" disabled={opening !== null} aria-busy={opening === file.path} onClick={() => onOpenPath(file.path)}>
                  <FileSpreadsheet size={18} aria-hidden="true" />
                  <span className="sheets-start__file-name">{file.name}</span>
                  <span className="sheets-start__file-meta">{folderOf(file.path)}</span>
                  <span className="sheets-start__file-meta">{when(file.openedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
