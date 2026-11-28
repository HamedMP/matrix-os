/** The File tab: a backstage with document details and the file commands. */
import { ClipboardPaste, Download, FileDown, FilePlus, FolderOpen, Info, Laptop, Save, SaveAll, X } from "lucide-react";
import type { RibbonBackstageTab } from "../../../../_shared/office-ui";
import type { SessionState } from "../../session/types";
import type { SheetCommands } from "./commands";

const ICON = 16;

function where(state: SessionState): string {
  if (state.source === "local") return "Opened from this computer. Save downloads the updated file; save a copy to Matrix to keep it in your home and save automatically.";
  if (state.path === null) return "Not saved yet. Save chooses a folder in your home.";
  return state.path;
}

function DocumentInfo({ state }: { state: SessionState }) {
  return (
    <div className="sheets-backstage-info">
      <h2>{state.name}</h2>
      <dl>
        <dt>Location</dt>
        <dd>{where(state)}</dd>
        <dt>Format</dt>
        <dd>{state.valuesOnlyFormat ? `${state.format.toUpperCase()}: values of the first sheet only` : "Workbook (.xlsx)"}</dd>
        <dt>Saving</dt>
        <dd>{state.autosave && state.path !== null ? "Changes are saved automatically." : "Changes are saved when you choose Save."}</dd>
      </dl>
    </div>
  );
}

export function fileTab(cmd: SheetCommands, state: SessionState): RibbonBackstageTab {
  const local = state.source === "local";
  const inMatrix = state.path !== null;
  return {
    id: "file",
    label: "File",
    mode: "backstage",
    backstage: {
      defaultItem: "info",
      backLabel: "Back to workbook",
      items: [
        { id: "info", label: "Info", icon: <Info size={ICON} />, render: () => <DocumentInfo state={state} /> },
        { id: "file-new", label: "New", icon: <FilePlus size={ICON} />, separatorBefore: true, onSelect: () => cmd["file-new"]() },
        { id: "file-open-matrix", label: "Open from Matrix", icon: <FolderOpen size={ICON} />, onSelect: () => cmd["file-open-matrix"]() },
        { id: "file-open-local", label: "Open from this computer", icon: <Laptop size={ICON} />, onSelect: () => cmd["file-open-local"]() },
        { id: "file-import-csv", label: "Import CSV by paste", icon: <ClipboardPaste size={ICON} />, onSelect: () => cmd["file-import-csv"]() },
        {
          id: "file-save",
          label: local ? "Save to this computer" : "Save",
          icon: <Save size={ICON} />,
          shortcut: "Ctrl+S",
          separatorBefore: true,
          onSelect: () => cmd["file-save"](),
        },
        { id: "file-save-copy", label: inMatrix ? "Save a copy" : "Save a copy to Matrix", icon: <SaveAll size={ICON} />, onSelect: () => cmd["file-save-copy"]() },
        { id: "file-download-xlsx", label: "Download a copy (.xlsx)", icon: <Download size={ICON} />, onSelect: () => cmd["file-download-xlsx"]() },
        { id: "file-download-csv", label: "Download as CSV", icon: <FileDown size={ICON} />, onSelect: () => cmd["file-download-csv"]() },
        { id: "file-close", label: "Close", icon: <X size={ICON} />, separatorBefore: true, onSelect: () => cmd["file-close"]() },
      ],
    },
  };
}
