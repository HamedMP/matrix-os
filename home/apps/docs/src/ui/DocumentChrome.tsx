/** Title-bar actions, the save-state indicator, banners and the status bar of an open document. */

import { FilePlus2, FolderOpen, PanelLeft, PanelRight, Save, X } from "lucide-react";
import { useMemo } from "react";
import { Dropdown } from "../../../_shared/office-ui";
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

export interface TitleActionsProps {
  state: SessionState;
  outlineOpen: boolean;
  panelOpen: boolean;
  onSave: () => void;
  onSaveCopy: () => void;
  onOpen: () => void;
  onNew: (kind: "blank" | "markdown") => void;
  onClose: () => void;
  onToggleOutline: () => void;
  onTogglePanel: () => void;
}

export function TitleActions(props: TitleActionsProps) {
  const { state, outlineOpen, panelOpen, onSave, onSaveCopy, onOpen, onNew, onClose, onToggleOutline, onTogglePanel } = props;
  const saving = state.saveStatus === "saving";
  return (
    <div className="docs-title-actions">
      <SaveIndicator state={state} />
      <button type="button" className="oui-button oui-button--primary" onClick={onSave} disabled={saving} title="Save (Ctrl+S)">
        <Save size={14} aria-hidden="true" />
        Save
      </button>
      <button type="button" className="oui-button" onClick={onSaveCopy} disabled={saving}>
        Save a copy
      </button>
      <button type="button" className="oui-icon-button" aria-label="Open a document" title="Open a document" onClick={onOpen}>
        <FolderOpen size={16} aria-hidden="true" />
      </button>
      <Dropdown
        label={<FilePlus2 size={16} aria-hidden="true" />}
        ariaLabel="New document"
        align="end"
        items={[
          { id: "blank", label: "Blank document" },
          { id: "markdown", label: "From Markdown…" },
        ]}
        onSelect={(id) => onNew(id === "markdown" ? "markdown" : "blank")}
      />
      <button type="button" className="oui-icon-button" aria-label="Outline" aria-pressed={outlineOpen} title="Show or hide the outline" onClick={onToggleOutline}>
        <PanelLeft size={16} aria-hidden="true" />
      </button>
      <button type="button" className="oui-icon-button" aria-label="Side panel" aria-pressed={panelOpen} title="Show or hide review, assistant and compare" onClick={onTogglePanel}>
        <PanelRight size={16} aria-hidden="true" />
      </button>
      <button type="button" className="oui-icon-button" aria-label="Close document" title="Close document" onClick={onClose}>
        <X size={16} aria-hidden="true" />
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
