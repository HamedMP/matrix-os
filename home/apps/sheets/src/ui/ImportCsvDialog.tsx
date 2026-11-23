/** Paste CSV or tab-separated text to start a new workbook from it. */
import { useState } from "react";
import { Dialog, TextField } from "../../../_shared/office-ui";
import { MAX_IMPORT_CHARS, parsePastedTable } from "./import-csv";

export interface ImportCsvDialogProps {
  open: boolean;
  onCancel: () => void;
  /** Receives the rows as typed text. */
  onImport: (rows: string[][]) => void;
}

export function ImportCsvDialog({ open, onCancel, onImport }: ImportCsvDialogProps) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    const parsed = parsePastedTable(text);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setText("");
    setError(null);
    onImport(parsed.rows);
  };

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title="Import CSV"
      description="Paste comma, semicolon or tab separated text. It opens as a new workbook you can save."
      size="lg"
      footer={
        <>
          <button type="button" className="oui-button oui-button--ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="oui-button oui-button--primary" onClick={submit}>
            Import
          </button>
        </>
      }
    >
      <TextField
        label="Text to import"
        value={text}
        onChange={(value) => {
          setText(value);
          setError(null);
        }}
        multiline
        rows={12}
        maxLength={MAX_IMPORT_CHARS}
        placeholder={"Name,Amount\nRent,1200\nFood,350"}
        error={error ?? undefined}
        autoFocus
      />
    </Dialog>
  );
}
