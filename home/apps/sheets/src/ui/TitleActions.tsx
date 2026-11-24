/** The title bar of an open workbook: back to the start screen, name, save state, Save and the panel toggles. */
import { Bot, FileSpreadsheet, ListChecks, Save } from "lucide-react";
import { Badge, DocumentTitleBar, ToolbarButton } from "../../../_shared/office-ui";
import type { SessionState } from "../session/types";
import type { PanelId } from "./ribbon/commands";
import { saveStatusText, titleSaveState } from "./title-state";

export interface SheetsTitleBarProps {
  state: SessionState;
  pendingChanges: number;
  panel: PanelId | null;
  onHome: () => void;
  onSave: () => void;
  onPanel: (panel: PanelId) => void;
}

export function SheetsTitleBar({ state, pendingChanges, panel, onHome, onSave, onPanel }: SheetsTitleBarProps) {
  const local = state.source === "local";
  return (
    <DocumentTitleBar
      appName="Sheets"
      onHome={onHome}
      name={state.name}
      leading={<FileSpreadsheet size={18} />}
      saveState={titleSaveState(state)}
      saveLabel={saveStatusText(state)}
      actions={
        <>
          {local && <Badge tone="accent">From this computer</Badge>}
          <ToolbarButton
            label={local ? "Save to this computer" : "Save"}
            shortcut="Ctrl+S"
            icon={<Save size={16} />}
            disabled={!state.dirty && state.path !== null}
            onClick={onSave}
          />
          <ToolbarButton
            label={pendingChanges > 0 ? `Review, ${pendingChanges} proposed changes` : "Review"}
            icon={<ListChecks size={16} />}
            showLabel
            pressed={panel === "review"}
            onClick={() => onPanel("review")}
          />
          <ToolbarButton label="Assistant" icon={<Bot size={16} />} showLabel pressed={panel === "assistant"} onClick={() => onPanel("assistant")} />
        </>
      }
    />
  );
}
