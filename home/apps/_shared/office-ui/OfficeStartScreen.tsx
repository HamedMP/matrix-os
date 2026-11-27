import { useId, useRef, type ReactNode } from "react";
import { EmptyState, Spinner } from "./Feedback";
import type { FileThumbKind } from "./FileThumb";
import { cx } from "./internal";
import { describeAccept, MAX_LOCAL_FILE_BYTES } from "./local-files";
import { MatrixFileBrowser, type BrowserFiles } from "./MatrixFileBrowser";
import { RecentFileList, type RecentEntry } from "./RecentFileList";
import type { StartFileEntry, StartFolderMemory } from "./start-model";

export interface StartTemplate {
  id: string;
  label: string;
  /** One short line under the label. */
  description?: string;
  /** A small drawing of the first page or sheet. */
  preview: ReactNode;
}

export interface StartAction {
  id: string;
  label: string;
  icon?: ReactNode;
  onClick: () => void;
}

export interface OfficeStartScreenProps {
  appName: string;
  /** The launcher artwork, shown when there is nothing recent. */
  artwork: string;
  /** An alert above everything, e.g. why a file did not open. */
  notice?: ReactNode;
  /** Shown as a floating status while a file opens ("Opening plan.docx"). */
  status?: string | null;
  /** Disables the actions while a file opens. */
  busy?: boolean;
  create: {
    heading: string;
    templates: readonly StartTemplate[];
    onCreate: (id: string) => void;
    /** Smaller ways to start, under the templates (e.g. "From Markdown…"). */
    more?: readonly StartAction[];
  };
  local: {
    accept: readonly string[];
    /** "a Word document" */
    noun: string;
    onChoose: () => void;
    maxBytes?: number;
  };
  recents: {
    heading: string;
    items: readonly RecentEntry[];
    /** Still reading the list. */
    loading?: boolean;
    onOpen: (path: string) => void;
    onRemove: (path: string) => Promise<void> | void;
    opening?: string | null;
    emptyHeadline: string;
    emptyDescription: string;
  };
  browser: {
    files: BrowserFiles;
    accept: readonly string[];
    onOpen: (path: string) => void;
    /** "Word documents" */
    fileNoun: string;
    /** Remembers the folder the owner last used; see `MatrixFileBrowser`. */
    memory?: StartFolderMemory;
  };
  /** The typed page for a file path (recent entries and listed files). */
  kindOf: (name: string) => { kind: FileThumbKind; tag?: string };
  now?: number;
  className?: string;
}

function UploadGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path d="M12 15V4m0 0L8 8m4-4l4 4M5 13v5a2 2 0 002 2h10a2 2 0 002-2v-5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The start screen shared by the office apps: start something new from a
 * template, pick up a recent file, browse the owner's Matrix home, or bring a
 * file from this computer (button or a drop anywhere on the window, which the
 * app's FileDropZone handles).
 */
export function OfficeStartScreen({ appName, artwork, notice, status, busy, create, local, recents, browser, kindOf, now, className }: OfficeStartScreenProps) {
  const ids = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const kindOfEntry = (entry: RecentEntry | StartFileEntry) => kindOf(entry.name);
  const hint = describeAccept(local.accept, local.maxBytes ?? MAX_LOCAL_FILE_BYTES);

  return (
    <div className={cx("oui-start", className)} aria-busy={busy || undefined}>
      <div className="oui-start__inner">
        {notice}
        <div className="oui-start__layout">
          <div className="oui-start__aside">
            <section className="oui-start__create" aria-labelledby={`${ids}-new`}>
              <h2 id={`${ids}-new`} className="oui-start__heading">
                {create.heading}
              </h2>
              <ul className="oui-start__templates">
                {create.templates.map((template) => (
                  <li key={template.id}>
                    <button type="button" className="oui-template" disabled={busy} onClick={() => create.onCreate(template.id)}>
                      <span className="oui-template__page" aria-hidden="true">
                        {template.preview}
                      </span>
                      <span className="oui-template__label">{template.label}</span>
                      {template.description && <span className="oui-template__description">{template.description}</span>}
                    </button>
                  </li>
                ))}
              </ul>
              {create.more && create.more.length > 0 && (
                <div className="oui-start__more">
                  {create.more.map((action) => (
                    <button key={action.id} type="button" className="oui-button oui-button--ghost oui-start__more-button" disabled={busy} onClick={action.onClick}>
                      {action.icon && <span aria-hidden="true">{action.icon}</span>}
                      {action.label}
                    </button>
                  ))}
                </div>
              )}
            </section>
            <section className="oui-start__local" aria-labelledby={`${ids}-local`}>
              <span className="oui-start__local-glyph">
                <UploadGlyph />
              </span>
              <h2 id={`${ids}-local`} className="oui-start__local-heading">
                From this computer
              </h2>
              <p className="oui-start__local-text">Drop {local.noun} anywhere in this window, or choose one.</p>
              <div className="oui-start__local-actions">
                <button type="button" className="oui-button" disabled={busy} onClick={local.onChoose}>
                  Choose a file…
                </button>
                <p className="oui-start__local-hint">{hint}</p>
              </div>
            </section>
          </div>
          <div className="oui-start__main">
            <section className="oui-start__panel oui-start__panel--recent" aria-labelledby={`${ids}-recent`}>
              <header className="oui-start__panel-head">
                <h2 id={`${ids}-recent`} className="oui-start__heading">
                  {recents.heading}
                </h2>
                {recents.items.length > 0 && <span className="oui-start__count">{recents.items.length}</span>}
              </header>
              <div className="oui-start__panel-body">
                {recents.loading ? (
                  <div className="oui-start__wait">
                    <Spinner label={`Loading ${recents.heading.toLowerCase()}`} />
                  </div>
                ) : (
                  <RecentFileList
                    label={recents.heading}
                    items={recents.items}
                    onOpen={recents.onOpen}
                    onRemove={recents.onRemove}
                    kindOf={kindOfEntry}
                    opening={recents.opening}
                    disabled={busy}
                    now={now}
                    empty={
                      <EmptyState
                        className="oui-start__empty"
                        icon={<img className="oui-empty__artwork" src={artwork} alt="" width={80} height={80} draggable={false} />}
                        headline={recents.emptyHeadline}
                        description={recents.emptyDescription}
                        action={{ label: "Browse your files", onClick: () => searchRef.current?.focus() }}
                      />
                    }
                  />
                )}
              </div>
            </section>
            <section className="oui-start__panel oui-start__panel--matrix" aria-labelledby={`${ids}-matrix`}>
              <header className="oui-start__panel-head">
                <h2 id={`${ids}-matrix`} className="oui-start__heading">
                  From Matrix
                </h2>
              </header>
              <MatrixFileBrowser
                className="oui-start__browser"
                files={browser.files}
                accept={browser.accept}
                onOpen={browser.onOpen}
                appName={appName}
                fileNoun={browser.fileNoun}
                memory={browser.memory}
                kindOf={kindOfEntry}
                disabled={busy}
                searchRef={searchRef}
                now={now}
              />
            </section>
          </div>
        </div>
      </div>
      {status && (
        <div className="oui-start__status">
          <Spinner label={status} size={14} />
          <span aria-hidden="true">{status}</span>
        </div>
      )}
    </div>
  );
}
