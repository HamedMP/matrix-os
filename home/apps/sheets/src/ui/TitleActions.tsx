/** Save state, Save, the file menu and the right panel toggles in the title bar. */
import { Bot, ChevronDown, ListChecks, Save } from "lucide-react";
import { Dropdown, ToolbarButton } from "../../../_shared/office-ui";
import type { SessionState } from "../session/types";

export type PanelId = "review" | "assistant";
export type FileMenuId = "new" | "open" | "copy" | "csv" | "close";
const FILE_MENU_IDS: readonly string[] = ["new", "open", "copy", "csv", "close"];

export interface TitleActionsProps {
  state: SessionState;
  pendingChanges: number;
  panel: PanelId | null;
  onSave: () => void;
  onFileMenu: (id: FileMenuId) => void;
  onPanel: (panel: PanelId) => void;
}

/** A few words for the save state. */
export function saveStatusText(state: SessionState): string {
  if (state.path === null) return state.dirty ? "Not saved yet" : "New workbook";
  switch (state.saveState) {
    case "saving":
      return "Saving";
    case "pending":
      return "Edited";
    case "conflict":
      return "Changed on disk";
    case "error":
      return "Not saved";
    default:
      return state.dirty ? "Edited" : "Saved";
  }
}

export function TitleActions({ state, pendingChanges, panel, onSave, onFileMenu, onPanel }: TitleActionsProps) {
  const status = saveStatusText(state);
  const warn = state.saveState === "conflict" || state.saveState === "error";
  return (
    <div className="sheets-title-actions">
      <span className={`sheets-save-state${warn ? " is-warning" : ""}`} role="status" aria-live="polite" title={state.saveError?.message}>
        {status}
      </span>
      <ToolbarButton label="Save" shortcut="Ctrl+S" icon={<Save size={16} />} disabled={!state.dirty && state.path !== null} onClick={onSave} />
      <Dropdown
        label={
          <span className="sheets-ribbon__dd">
            File <ChevronDown size={14} aria-hidden="true" />
          </span>
        }
        ariaLabel="File"
        align="end"
        items={[
          { id: "new", label: "New blank workbook" },
          { id: "open", label: "Open" },
          { id: "copy", label: "Save a copy", separatorBefore: true },
          { id: "csv", label: "Download as CSV" },
          { id: "close", label: "Close workbook", separatorBefore: true },
        ]}
        onSelect={(id) => {
          if (FILE_MENU_IDS.includes(id)) onFileMenu(id as FileMenuId);
        }}
      />
      <ToolbarButton
        label={pendingChanges > 0 ? `Review, ${pendingChanges} proposed changes` : "Review"}
        icon={<ListChecks size={16} />}
        showLabel
        pressed={panel === "review"}
        onClick={() => onPanel("review")}
      />
      <ToolbarButton label="Assistant" icon={<Bot size={16} />} showLabel pressed={panel === "assistant"} onClick={() => onPanel("assistant")} />
    </div>
  );
}
