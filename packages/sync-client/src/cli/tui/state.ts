import type { TuiAction } from "./actions.js";
import type { QuickActionId } from "./quick-actions.js";
import type { TuiActionExecutionState } from "./action-executor.js";

export type TuiViewMode = "home" | "palette" | "sessions" | "setup" | "confirm" | "action-status";

export interface TuiSelectionState {
  paletteIndex: number;
  quickActionIndex: number;
  sessionIndex: number;
}

export interface TuiConfirmState {
  action: TuiAction;
  typedValue: string;
}

export interface MatrixTuiState {
  mode: TuiViewMode;
  paletteQuery: string;
  selection: TuiSelectionState;
  selectedQuickActionId?: QuickActionId;
  confirming?: TuiConfirmState;
  execution: TuiActionExecutionState;
}

export function createInitialTuiState(): MatrixTuiState {
  return {
    mode: "home",
    paletteQuery: "",
    selection: {
      paletteIndex: 0,
      quickActionIndex: 0,
      sessionIndex: 0,
    },
    execution: { status: "idle" },
  };
}
