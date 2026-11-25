/**
 * Slugs of the apps Matrix ships in the OS home template (`home/apps/**`).
 * Share (Matrix.page publishing and organization sharing) is for apps the owner
 * built, so these never show it. `tests/ui/default-app-share.test.ts` keeps this
 * list equal to the shipped manifests.
 */
export const MATRIX_DEFAULT_APP_SLUGS: ReadonlySet<string> = new Set([
  "2048",
  "app-gallery",
  "backgammon",
  "calculator",
  "chess",
  "clock",
  "expense-tracker",
  "games",
  "minesweeper",
  "notes",
  "pomodoro",
  "profile",
  "resource-manager",
  "snake",
  "social",
  "solitaire",
  "stickies",
  "task-manager",
  "tetris",
  "todo",
  "weather",
  "whiteboard",
  "widgets",
  "win-sticky-notes",
  "winxp-minesweeper",
]);

/** Whether an app window should offer Share: only apps the owner built. */
export function isShareableAppSlug(slug: string): boolean {
  return !MATRIX_DEFAULT_APP_SLUGS.has(slug);
}
