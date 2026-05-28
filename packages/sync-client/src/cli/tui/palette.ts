import type { TuiAction } from "./actions.js";

export interface PaletteResult {
  action: TuiAction;
  score: number;
}

function haystackForAction(action: TuiAction): string {
  return [
    action.id,
    action.title,
    action.group,
    action.directCommand ?? "",
    ...action.aliases,
    ...action.intents,
  ].join(" ").toLowerCase();
}

function scoreAction(action: TuiAction, query: string): number {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return 1;
  }
  const title = action.title.toLowerCase();
  const group = action.group.toLowerCase();
  const haystack = haystackForAction(action);
  if (title === normalized) return 100;
  if (title.includes(normalized)) return 80;
  if (group.includes(normalized)) return 70;
  if (action.aliases.some((alias) => alias.toLowerCase().includes(normalized))) return 60;
  if (action.intents.some((intent) => intent.toLowerCase().includes(normalized))) return 50;
  const terms = normalized.split(/\s+/).filter(Boolean);
  if (terms.length > 0 && terms.every((term) => haystack.includes(term))) return 40;
  return 0;
}

export function searchTuiActions(actions: readonly TuiAction[], query: string, limit = 10): TuiAction[] {
  return actions
    .map((action) => ({ action, score: scoreAction(action, query) }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.action.title.localeCompare(b.action.title))
    .slice(0, limit)
    .map((result) => result.action);
}
