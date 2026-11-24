/** What the ribbon shows (pressed and disabled states) and small builders for its items. */
import type { ReactNode } from "react";
import type { RibbonItem } from "../../../../_shared/office-ui";
import type { ReviewState } from "../../review";
import type { CellStyle } from "../../session/engine";
import type { SessionState } from "../../session/types";
import type { PanelId, SheetCommandId, SheetCommands, ViewOptions } from "./commands";

export interface RibbonModel {
  state: SessionState;
  /** Style of the active cell. */
  style: CellStyle;
  review: ReviewState;
  panel: PanelId | null;
  view: ViewOptions;
  filtered: boolean;
  /** Defined names the active sheet can go to. */
  names: readonly string[];
  /** False when the assistant's model actions are off. */
  aiAvailable: boolean;
  assistantBusy: boolean;
  /** The colour each colour button applies with its face. */
  colors: { text: string | null; fill: string | null };
}

interface Look {
  shortcut?: string;
  disabled?: boolean;
  /** "large" puts the icon above the label. */
  size?: "large" | "small";
  /** Small items only: show the label next to the icon. Default false. */
  showLabel?: boolean;
}

export function commandButton(cmd: SheetCommands, id: SheetCommandId, label: string, icon: ReactNode, look: Look = {}): RibbonItem {
  return { kind: "button", id, label, icon, shortcut: look.shortcut, disabled: look.disabled, size: look.size, showLabel: look.showLabel ?? false, onClick: () => cmd[id]() };
}

export function commandToggle(cmd: SheetCommands, id: SheetCommandId, label: string, icon: ReactNode, pressed: boolean, look: Look = {}): RibbonItem {
  return { kind: "toggle", id, label, icon, pressed, shortcut: look.shortcut, disabled: look.disabled, size: look.size, showLabel: look.showLabel ?? false, onToggle: () => cmd[id]() };
}
