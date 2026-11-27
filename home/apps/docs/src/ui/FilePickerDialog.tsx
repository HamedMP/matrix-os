/**
 * The Open dialog: the office kit's Matrix file browser (folders and `.docx`
 * files only) in a dialog. Clicking a document, or Enter on it, opens it.
 */

import type { MatrixOSFiles } from "../../../_shared/matrix-os";
import { Dialog, MatrixFileBrowser, type StartFolderMemory } from "../../../_shared/office-ui";

export interface FilePickerDialogProps {
  open: boolean;
  files: Pick<MatrixOSFiles, "list">;
  /** Remembers the folder the owner last browsed. */
  memory?: StartFolderMemory;
  title?: string;
  onClose: () => void;
  onPick: (path: string) => void;
}

const ACCEPT: readonly string[] = [".docx"];
const docKind = () => ({ kind: "document" as const });

export function FilePickerDialog({ open, files, memory, title = "Open a document", onClose, onPick }: FilePickerDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description="Folders and Word documents in your home."
      size="lg"
      footer={
        <button type="button" className="oui-button" onClick={onClose}>
          Cancel
        </button>
      }
    >
      {open && <MatrixFileBrowser files={files} memory={memory} accept={ACCEPT} appName="Docs" fileNoun="Word documents" kindOf={docKind} onOpen={onPick} />}
    </Dialog>
  );
}
