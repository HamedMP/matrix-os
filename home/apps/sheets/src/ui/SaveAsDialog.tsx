/** Asks where to save a workbook that has no file yet. */
import { type FormEvent, useState } from "react";
import { Dialog, TextField } from "../../../_shared/office-ui";
import { buildSavePath } from "./file-actions";

export interface SaveAsDialogProps {
  open: boolean;
  initialName: string;
  onCancel: () => void;
  /** Resolves with a message when saving failed, or null when it worked. */
  onSave: (path: string) => Promise<string | null>;
  /** Dialog title. Default "Save workbook". */
  title?: string;
}

export function SaveAsDialog({ open, initialName, onCancel, onSave, title = "Save workbook" }: SaveAsDialogProps) {
  const [folder, setFolder] = useState("Documents");
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    const built = buildSavePath(folder, name);
    if (!built.ok) {
      setError(built.message);
      return;
    }
    setBusy(true);
    try {
      setError(await onSave(built.path));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      description="Choose a folder in your home and a file name. A name ending in .csv keeps the values of the first sheet only."
      size="sm"
      footer={
        <>
          <button type="button" className="oui-button oui-button--ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" form="sheets-save-as" className="oui-button oui-button--primary" disabled={busy}>
            {busy ? "Saving" : "Save"}
          </button>
        </>
      }
    >
      <form id="sheets-save-as" className="sheets-form" onSubmit={(event) => void submit(event)}>
        <TextField label="Folder" value={folder} onChange={setFolder} maxLength={1000} hint="For example Documents or Projects/2026" />
        <TextField label="File name" value={name} onChange={setName} maxLength={200} autoFocus error={error ?? undefined} />
      </form>
    </Dialog>
  );
}
