/** Title-bar actions, the save-state indicator, banners and the status bar of an open document. */

import { HardDrive, Save } from "lucide-react";
import { useMemo } from "react";
import { Badge } from "../../../_shared/office-ui";
import type { DocumentSession, SessionState } from "../session/index";
import { countWords, describeSaveState, plural } from "./status-model";

export function SaveIndicator({ state }: { state: SessionState }) {
  const indicator = describeSaveState(state);
  return (
    <span className={`docs-save docs-save--${indicator.tone}`} role="status" aria-live="polite" data-testid="save-state">
      {indicator.label}
    </span>
  );
}

export interface TitleBarActionsProps {
  state: SessionState;
  onSave: () => void;
}

/** The right side of the title bar: where the document is from, its save state and Save. */
export function TitleBarActions({ state, onSave }: TitleBarActionsProps) {
  const local = state.source === "local";
  return (
    <div className="docs-title-actions">
      {local && (
        <Badge tone="accent" className="docs-source-badge">
          <HardDrive size={12} aria-hidden="true" /> From this computer
        </Badge>
      )}
      <SaveIndicator state={state} />
      <button
        type="button"
        className="oui-button oui-button--primary"
        onClick={onSave}
        disabled={state.saveStatus === "saving"}
        title={local ? "Save: downloads the file to this computer (Ctrl+S)" : "Save (Ctrl+S)"}
        aria-keyshortcuts="Control+S"
      >
        <Save size={14} aria-hidden="true" />
        Save
      </button>
    </div>
  );
}

export function ConflictBanner({ onReload, onSaveCopy }: { onReload: () => void; onSaveCopy: () => void }) {
  return (
    <div role="alert" className="docs-banner docs-banner--conflict">
      <span>
        <strong>This file changed elsewhere</strong> since you opened it. Your version is still here and was not written.
      </span>
      <span className="docs-banner__actions">
        <button type="button" className="oui-button" onClick={onSaveCopy}>
          Save a copy
        </button>
        <button type="button" className="oui-button oui-button--danger" onClick={onReload}>
          Reload from file (drops your changes)
        </button>
      </span>
    </div>
  );
}

export function SaveErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="docs-banner docs-banner--error">
      <span>
        <strong>Not saved.</strong> {message}
      </span>
      <button type="button" className="oui-button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

export function StatusBar({ session, state, docVersion }: { session: DocumentSession; state: SessionState; docVersion: number }) {
  const words = useMemo(() => {
    const doc = session.document;
    return doc === null ? 0 : countWords(doc.getPlainText({ view: "final" }));
    // docVersion stands for the document content.
  }, [session, docVersion]);
  return (
    <div className="docs-status">
      <span>{plural(words, "word")}</span>
      <span>{plural(state.revisionCount, "revision")}</span>
      <span>{plural(state.commentCount, "comment")}</span>
      {state.tracking && <span className="docs-status__tracking">Track changes on</span>}
    </div>
  );
}
