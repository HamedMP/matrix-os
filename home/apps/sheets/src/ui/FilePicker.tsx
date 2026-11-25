/** Browses the home folder for .xlsx, .csv and .tsv files, with the office kit's Matrix file browser. */
import { Dialog, MatrixFileBrowser } from "../../../_shared/office-ui";
import type { SheetsBridge } from "./bridge";
import { LOCAL_ACCEPT } from "./document-flow";
import { sheetKind } from "./StartScreen";

export interface FilePickerProps {
  open: boolean;
  files: SheetsBridge["files"];
  onCancel: () => void;
  onPick: (path: string) => void;
}

const kindOf = (entry: { name: string }) => sheetKind(entry.name);

export function FilePicker({ open, files, onCancel, onPick }: FilePickerProps) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title="Open a spreadsheet"
      description="Choose an .xlsx, .csv or .tsv file from your home."
      size="lg"
      footer={
        <button type="button" className="oui-button" onClick={onCancel}>
          Cancel
        </button>
      }
    >
      {open && <MatrixFileBrowser files={files} accept={LOCAL_ACCEPT} appName="Sheets" fileNoun="spreadsheets" kindOf={kindOf} onOpen={onPick} />}
    </Dialog>
  );
}
