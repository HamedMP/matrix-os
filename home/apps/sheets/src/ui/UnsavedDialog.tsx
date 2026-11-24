/** Asks what to do with edits that were not saved before leaving a workbook: Save, Discard or Cancel. */
import { Dialog } from "../../../_shared/office-ui";
import type { SessionState } from "../session/types";

export interface UnsavedDialogProps {
  /** The workbook with the edits, or null when the dialog is closed. */
  state: SessionState | null;
  open: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

function explanation(state: SessionState): string {
  if (state.source === "local") return "This workbook came from this computer. Save downloads the updated file; Discard drops your edits.";
  if (state.path === null) return "This workbook was never saved. Save chooses a folder in your home; Discard drops it.";
  return "They could not be written to the file. Save tries again; Discard drops them.";
}

export function UnsavedDialog({ state, open, onSave, onDiscard, onCancel }: UnsavedDialogProps) {
  return (
    <Dialog
      open={open && state !== null}
      onClose={onCancel}
      role="alertdialog"
      size="sm"
      title={`Save changes to ${state?.name ?? "this workbook"}?`}
      description={state === null ? undefined : explanation(state)}
      footer={
        <>
          <button type="button" className="oui-button oui-button--ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="oui-button oui-button--danger" onClick={onDiscard}>
            Discard
          </button>
          <button type="button" className="oui-button oui-button--primary" onClick={onSave}>
            Save
          </button>
        </>
      }
    />
  );
}
