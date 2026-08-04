// Pure commit-DAG lane assignment for the git graph panel. Adapted from
// SlayZone's dag-layout reservation-table approach, simplified to work from
// topology alone (sha + parents) since the gateway log endpoint does not
// resolve an owning branch per commit. Commits arrive newest-first; parents
// are always at a later row or below the loaded window.

export interface GraphLayoutCommit {
  sha: string;
  parents: string[];
}

export interface GraphRowLayout {
  col: number;
  colorIndex: number;
}

export interface GraphEdge {
  fromRow: number;
  fromCol: number;
  /** -1 when the parent sits below the loaded window (edge runs to the bottom). */
  toRow: number;
  toCol: number;
  colorIndex: number;
}

export interface GraphLayout {
  rows: GraphRowLayout[];
  edges: GraphEdge[];
  columnCount: number;
}

// Lane colors are theme-driven, never hardcoded hex: each lane maps onto a
// semantic CSS variable every theme defines from its own palette (see
// design/themes/apply.ts — --info/--success/--warning/--highlight come from
// the theme's chart1–chart4), so the DAG re-themes with the workspace.
// GitGraph resolves these through inline styles; var() is invalid inside SVG
// presentation attributes, so strokes/fills there go through `style`.
export const LANE_COLOR_VARS = [
  "--info",
  "--success",
  "--warning",
  "--highlight",
  "--accent",
  "--danger",
] as const;

export function laneColorVar(col: number): string {
  return LANE_COLOR_VARS[col % LANE_COLOR_VARS.length] ?? LANE_COLOR_VARS[0];
}

/** Inline-style color reference for a lane, e.g. "var(--info)". */
export function laneColor(col: number): string {
  return `var(${laneColorVar(col)})`;
}

export function computeGraphLayout(commits: GraphLayoutCommit[]): GraphLayout {
  const rows: GraphRowLayout[] = [];
  const edges: GraphEdge[] = [];
  // Reservation table: column index -> sha expected to appear in that lane.
  const columns: (string | null)[] = [];

  const firstFreeColumn = (): number => {
    const free = columns.indexOf(null);
    if (free >= 0) return free;
    columns.push(null);
    return columns.length - 1;
  };

  const hashToRow = new Map<string, number>();

  for (let row = 0; row < commits.length; row += 1) {
    const commit = commits[row]!;
    hashToRow.set(commit.sha, row);

    const reserved = columns.indexOf(commit.sha);
    const col = reserved >= 0 ? reserved : firstFreeColumn();
    columns[col] = null;
    // A hash may be reserved in several lanes (e.g. fork point of multiple
    // branches); once placed, every other reservation for it is stale.
    for (let i = 0; i < columns.length; i += 1) {
      if (columns[i] === commit.sha) columns[i] = null;
    }
    rows.push({ col, colorIndex: col });

    const [firstParent, ...extraParents] = commit.parents;
    if (firstParent) {
      columns[col] = firstParent;
    }
    const reservedParents = new Set(columns.filter((sha): sha is string => sha !== null));
    for (const parent of extraParents) {
      if (reservedParents.has(parent)) continue;
      columns[firstFreeColumn()] = parent;
      reservedParents.add(parent);
    }
  }

  for (let row = 0; row < commits.length; row += 1) {
    const commit = commits[row]!;
    const fromCol = rows[row]!.col;
    for (const parent of commit.parents) {
      const toRow = hashToRow.get(parent) ?? -1;
      const toCol = toRow >= 0 ? rows[toRow]!.col : columns.indexOf(parent);
      const targetCol = toCol >= 0 ? toCol : fromCol;
      edges.push({ fromRow: row, fromCol, toRow, toCol: targetCol, colorIndex: targetCol });
    }
  }

  return { rows, edges, columnCount: columns.length };
}
