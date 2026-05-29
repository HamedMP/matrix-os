import { DEFAULT_TUI_ACTIONS, getTuiActionById, type TuiAction } from "./actions.js";

export const QUICK_ACTION_IDS = [
  "shell.new",
  "shell.sessions",
  "setup.agents",
  "status.doctor",
  "account.login",
] as const;

export type QuickActionId = (typeof QUICK_ACTION_IDS)[number];

export interface QuickAction {
  id: QuickActionId;
  action: TuiAction;
  shortcut: string;
}

export function getQuickActions(actions: readonly TuiAction[] = DEFAULT_TUI_ACTIONS): QuickAction[] {
  return QUICK_ACTION_IDS.map((id) => {
    const action = getTuiActionById(id, actions);
    if (!action || !action.shortcut) {
      throw new Error(`Missing quick action registration: ${id}`);
    }
    return { id, action, shortcut: action.shortcut };
  });
}

export function getQuickActionByShortcut(shortcut: string, actions: readonly TuiAction[] = DEFAULT_TUI_ACTIONS): QuickAction | undefined {
  return getQuickActions(actions).find((quickAction) => quickAction.shortcut === shortcut);
}
