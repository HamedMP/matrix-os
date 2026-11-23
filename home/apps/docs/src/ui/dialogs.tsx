/** Small dialogs of the Docs shell: new from Markdown, save as, and unsaved changes. */

import { useState } from "react";
import { Dialog, TextField } from "../../../_shared/office-ui";
import { DOCX_EXTENSION, type DocumentSession, directoryOf, fileName } from "../session/index";
import { isDocxPath } from "./file-picker-model";
import type { BlockedReason } from "./use-docs-session";
import { MAX_MARKDOWN_LENGTH } from "./use-docs-session";

export function MarkdownDialog({ open, onClose, onCreate }: { open: boolean; onClose: () => void; onCreate: (markdown: string) => void }) {
  const [markdown, setMarkdown] = useState("");
  const submit = () => {
    if (markdown.trim() === "") return;
    onCreate(markdown);
    setMarkdown("");
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New from Markdown"
      description="Paste Markdown: headings, lists, tables, bold, italic and links become a Word document."
      size="lg"
      footer={
        <>
          <button type="button" className="oui-button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="oui-button oui-button--primary" disabled={markdown.trim() === ""} onClick={submit}>
            Create
          </button>
        </>
      }
    >
      <TextField label="Markdown" value={markdown} onChange={setMarkdown} multiline rows={14} maxLength={MAX_MARKDOWN_LENGTH} placeholder={"# Title\n\nWrite or paste Markdown here."} />
    </Dialog>
  );
}

/** The path for a folder and a name, with `.docx` added when missing; null when it cannot be used. */
export function savePath(folder: string, name: string): string | null {
  const cleanFolder = folder.trim().replace(/^\/+|\/+$/g, "");
  let cleanName = name.trim();
  if (cleanName === "") return null;
  if (!cleanName.toLowerCase().endsWith(DOCX_EXTENSION)) cleanName += DOCX_EXTENSION;
  const path = cleanFolder === "" ? cleanName : `${cleanFolder}/${cleanName}`;
  return isDocxPath(path) ? path : null;
}

export function SaveAsDialog({ open, session, onClose, onSaved }: { open: boolean; session: DocumentSession; onClose: () => void; onSaved: (path: string) => void }) {
  return open ? <SaveAsBody session={session} onClose={onClose} onSaved={onSaved} /> : null;
}

function SaveAsBody({ session, onClose, onSaved }: { session: DocumentSession; onClose: () => void; onSaved: (path: string) => void }) {
  const state = session.getState();
  const [folder, setFolder] = useState(state.path === null ? "Documents" : directoryOf(state.path));
  const [name, setName] = useState(state.path === null ? state.name : fileName(state.path));
  const [error, setError] = useState<string | null>(null);
  const [exists, setExists] = useState(false);
  const [busy, setBusy] = useState(false);
  const path = savePath(folder, name);

  const save = async (overwrite: boolean) => {
    if (path === null) return;
    setBusy(true);
    setError(null);
    const result = await session.saveAs(path, { overwrite });
    setBusy(false);
    if (result.status === "saved") {
      onSaved(result.path);
      onClose();
      return;
    }
    if (result.status === "error") {
      setExists(result.error.code === "already_exists");
      setError(result.error.message);
    } else if (result.status === "conflict") setError("The file changed while saving. Try again.");
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Save document"
      description="Choose where in your home to keep this document."
      size="sm"
      footer={
        <>
          <button type="button" className="oui-button" onClick={onClose}>
            Cancel
          </button>
          {exists && (
            <button type="button" className="oui-button oui-button--danger" disabled={busy || path === null} onClick={() => void save(true)}>
              Replace
            </button>
          )}
          <button type="button" className="oui-button oui-button--primary" disabled={busy || path === null} onClick={() => void save(false)}>
            Save
          </button>
        </>
      }
    >
      <div className="docs-form">
        <TextField label="Folder" value={folder} onChange={(value) => { setFolder(value); setExists(false); }} hint="Leave empty for your home folder." />
        <TextField label="File name" value={name} onChange={(value) => { setName(value); setExists(false); }} error={path === null && name.trim() !== "" ? "This name cannot be used." : undefined} />
        {error !== null && (
          <p role="alert" className="docs-inline-alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

const REASONS: Record<BlockedReason, string> = {
  unsaved_changes: "This document has unsaved changes.",
  conflict: "This document changed elsewhere and your version is not saved.",
  save_failed: "Your changes could not be saved.",
};

export function UnsavedDialog({ reason, onCancel, onDiscard }: { reason: BlockedReason | null; onCancel: () => void; onDiscard: () => void }) {
  return (
    <Dialog
      open={reason !== null}
      onClose={onCancel}
      role="alertdialog"
      title="Discard unsaved changes?"
      description={reason === null ? undefined : `${REASONS[reason]} Continuing drops them. Use Save or Save a copy first to keep them.`}
      size="sm"
      footer={
        <>
          <button type="button" className="oui-button" onClick={onCancel}>
            Keep editing
          </button>
          <button type="button" className="oui-button oui-button--danger" onClick={onDiscard}>
            Discard and continue
          </button>
        </>
      }
    />
  );
}
