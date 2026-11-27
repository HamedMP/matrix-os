/** Small dialogs of the Docs shell: new from Markdown, save to the home, and unsaved changes. */

import { useState } from "react";
import { Dialog, TextField } from "../../../_shared/office-ui";
import { type DocumentSession, directoryOf, fileName } from "../session/index";
import { savePath } from "./file-picker-model";
import type { BlockedReason, PendingLeave } from "./use-docs-session";
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

export interface SaveAsDialogProps {
  open: boolean;
  session: DocumentSession;
  /** Default "Save document". */
  title?: string;
  description?: string;
  onClose: () => void;
  onSaved: (path: string) => void;
}

export function SaveAsDialog({ open, ...props }: SaveAsDialogProps) {
  return open ? <SaveAsBody {...props} /> : null;
}

function SaveAsBody({ session, title = "Save document", description = "Choose where in your home to keep this document.", onClose, onSaved }: Omit<SaveAsDialogProps, "open">) {
  const state = session.getState();
  // The document this dialog was opened for; the app closes it when another one opens, and it never saves another.
  const [openedFor] = useState(state.documentKey);
  const stillOpen = () => session.getState().documentKey === openedFor;
  const [folder, setFolder] = useState(state.path === null ? "Documents" : directoryOf(state.path));
  const [name, setName] = useState(state.path === null ? state.name : fileName(state.path));
  const [error, setError] = useState<string | null>(null);
  const [exists, setExists] = useState(false);
  const [busy, setBusy] = useState(false);
  const path = savePath(folder, name);

  const save = async (overwrite: boolean) => {
    if (path === null) return;
    if (!stillOpen()) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    let result: Awaited<ReturnType<DocumentSession["saveAs"]>>;
    try {
      result = await session.saveAs(path, { overwrite });
    } catch (error) {
      console.warn("docs: save as failed", error instanceof Error ? error.name : error);
      setError("The document could not be saved. Try again.");
      return;
    } finally {
      setBusy(false);
    }
    // Another document opened while this one was written: what was to follow (such as closing) is not for it.
    if (!stillOpen()) return;
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
      title={title}
      description={description}
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

export interface UnsavedDialogProps {
  pending: PendingLeave | null;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

/** Save, Discard or Cancel before leaving a document with unsaved changes. */
export function UnsavedDialog({ pending, onSave, onDiscard, onCancel }: UnsavedDialogProps) {
  const busy = pending?.busy === true;
  const where = pending?.local ? " Save downloads it to this computer." : "";
  return (
    <Dialog
      open={pending !== null}
      onClose={busy ? () => undefined : onCancel}
      role="alertdialog"
      title={pending === null ? "Unsaved changes" : `Save changes to “${pending.name}”?`}
      description={pending === null ? undefined : `${REASONS[pending.reason]} Save them before leaving, or discard them.${where}`}
      size="sm"
      footer={
        <>
          <button type="button" className="oui-button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="oui-button oui-button--danger" onClick={onDiscard} disabled={busy}>
            Discard
          </button>
          <button type="button" className="oui-button oui-button--primary" onClick={onSave} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      {pending?.error != null && (
        <p role="alert" className="docs-inline-alert">
          <span>
            <strong>Not saved.</strong> {pending.error}
          </span>
        </p>
      )}
    </Dialog>
  );
}
