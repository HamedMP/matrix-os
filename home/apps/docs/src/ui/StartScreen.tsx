/** The start screen: new blank, open from Matrix or from this computer, new from Markdown, and recent documents. */

import { FilePlus2, FileText, FileType2, FolderOpen, HardDrive } from "lucide-react";
import { AppFrame, EmptyState, Spinner } from "../../../_shared/office-ui";
import { type RecentFile, type SessionError, directoryOf } from "../session/index";

/** The launcher artwork, shown where the app introduces itself. */
const appArtwork = new URL("../../../../system/icons/v3-docs.png", import.meta.url).href;

export interface StartScreenProps {
  recents: readonly RecentFile[];
  loading: boolean;
  error: SessionError | null;
  onNewBlank: () => void;
  onOpen: () => void;
  /** Opens a .docx from the owner's computer. */
  onOpenLocal: () => void;
  onNewFromMarkdown: () => void;
  onOpenRecent: (path: string) => void;
}

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function when(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? "" : DATE_FORMAT.format(time);
}

export function StartScreen({ recents, loading, error, onNewBlank, onOpen, onOpenLocal, onNewFromMarkdown, onOpenRecent }: StartScreenProps) {
  return (
    <AppFrame title="Docs" titleIcon={<FileText size={18} />}>
      <div className="docs-start">
        {error !== null && (
          <div role="alert" className="docs-start__error">
            <strong>The document could not be opened.</strong>
            <span>{error.message}</span>
            <span>The file was not changed.</span>
          </div>
        )}
        {loading && <Spinner label="Opening document" />}
        <section aria-labelledby="docs-start-new" className="docs-start__section">
          <h2 id="docs-start-new" className="docs-start__heading">
            Start
          </h2>
          <div className="docs-start__actions">
            <button type="button" className="docs-start__card" onClick={onNewBlank} disabled={loading}>
              <FilePlus2 size={22} aria-hidden="true" />
              <span className="docs-start__card-title">New blank document</span>
              <span className="docs-muted">An empty Word document.</span>
            </button>
            <button type="button" className="docs-start__card" onClick={onOpen} disabled={loading}>
              <FolderOpen size={22} aria-hidden="true" />
              <span className="docs-start__card-title">Open from Matrix…</span>
              <span className="docs-muted">A .docx file from your home.</span>
            </button>
            <button type="button" className="docs-start__card" onClick={onOpenLocal} disabled={loading}>
              <HardDrive size={22} aria-hidden="true" />
              <span className="docs-start__card-title">Open from this computer…</span>
              <span className="docs-muted">A .docx file on this device, or drop one on the window.</span>
            </button>
            <button type="button" className="docs-start__card" onClick={onNewFromMarkdown} disabled={loading}>
              <FileType2 size={22} aria-hidden="true" />
              <span className="docs-start__card-title">New from Markdown</span>
              <span className="docs-muted">Paste Markdown to start a document.</span>
            </button>
          </div>
        </section>
        <section aria-labelledby="docs-start-recent" className="docs-start__section">
          <h2 id="docs-start-recent" className="docs-start__heading">
            Recent documents
          </h2>
          {recents.length === 0 ? (
            <EmptyState
              icon={<img className="oui-empty__artwork" src={appArtwork} alt="" width={80} height={80} draggable={false} />}
              headline="No recent documents"
              description="Documents you open appear here."
              action={loading ? undefined : { label: "Browse files…", onClick: onOpen }}
            />
          ) : (
            <ul className="docs-start__recents">
              {recents.map((recent) => (
                <li key={recent.path}>
                  <button type="button" className="docs-start__recent" onClick={() => onOpenRecent(recent.path)} disabled={loading}>
                    <FileText size={16} aria-hidden="true" />
                    <span className="docs-start__recent-name">{recent.name}</span>
                    <span className="docs-muted">{directoryOf(recent.path) || "Home"}</span>
                    <span className="docs-muted docs-start__recent-time">{when(recent.openedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </AppFrame>
  );
}
