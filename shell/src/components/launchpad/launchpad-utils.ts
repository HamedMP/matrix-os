/**
 * Pure pagination/filter math for the macOS Launchpad launcher. Kept
 * component-free so the layout rules are unit-testable and shared between the
 * viewport-sizing effect and the render path.
 *
 * The cell constants must stay in sync with the px sizes in launchpad.css
 * (--launchpad-cell-w / --launchpad-cell-h).
 */

export const LAUNCHPAD_CELL_WIDTH = 132;
export const LAUNCHPAD_CELL_HEIGHT = 152;
// Vertical chrome outside the grid area: search row + page-dots row. The grid
// gets whatever viewport height remains.
export const LAUNCHPAD_CHROME_HEIGHT = 190;

const MIN_COLUMNS = 2;
const MIN_ROWS = 1;

export function computeLaunchpadColumns(viewportWidth: number): number {
  return Math.max(MIN_COLUMNS, Math.floor(viewportWidth / LAUNCHPAD_CELL_WIDTH));
}

export function computeLaunchpadRows(viewportHeight: number): number {
  const available = viewportHeight - LAUNCHPAD_CHROME_HEIGHT;
  return Math.max(MIN_ROWS, Math.floor(available / LAUNCHPAD_CELL_HEIGHT));
}

export function computeLaunchpadPageSize(viewportWidth: number, viewportHeight: number): number {
  return computeLaunchpadColumns(viewportWidth) * computeLaunchpadRows(viewportHeight);
}

/** Chunk apps into pages. Always returns at least one (possibly empty) page. */
export function paginateLaunchpadApps<T>(apps: readonly T[], pageSize: number): T[][] {
  if (pageSize < 1) return [apps.slice()];
  const pages: T[][] = [];
  for (let i = 0; i < apps.length; i += pageSize) {
    pages.push(apps.slice(i, i + pageSize));
  }
  return pages.length > 0 ? pages : [[]];
}

/** Case-insensitive substring match on the app name; empty query returns all. */
export function filterLaunchpadApps<T extends { name: string }>(
  apps: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return apps.slice();
  return apps.filter((app) => app.name.toLowerCase().includes(needle));
}
