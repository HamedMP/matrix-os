/** The status bar: sum, average and count of the selection, and calculation state. */
import { useMemo } from "react";
import type { GridSelection } from "../grid";
import type { CellRange } from "../session/engine";
import type { SheetSession } from "../session/session";
import type { SessionState } from "../session/types";
import { formatStat, selectionStats } from "./selection-stats";

export interface StatusBarProps {
  session: SheetSession;
  state: SessionState;
  selection: GridSelection;
  filtered: boolean;
}

export function StatusBar({ session, state, selection, filtered }: StatusBarProps) {
  const { revision } = state;
  const stats = useMemo(() => {
    // `revision` makes the summary follow edits to the selected cells.
    if (revision < 0) return null;
    const ranges: CellRange[] = selection.ranges.map((range) => ({ start: range.start, end: range.end }));
    return selectionStats(session, selection.sheet, ranges);
  }, [session, selection, revision]);

  return (
    <div className="sheets-status">
      <span className="sheets-status__left">
        {!state.calcComplete && <span className="sheets-status__warn">Some values are out of date</span>}
        {filtered && <span>Filtered view</span>}
        {state.valuesOnlyFormat && <span>CSV keeps values of the first sheet only</span>}
      </span>
      <span className="sheets-status__stats" aria-live="polite" data-testid="selection-stats">
        {stats !== null && stats.count > 0 && (
          <>
            {stats.numericCount > 0 && <span>Sum: {formatStat(stats.sum)}</span>}
            {stats.average !== null && <span>Average: {formatStat(stats.average)}</span>}
            <span>Count: {stats.count.toLocaleString()}</span>
            {stats.truncated && <span>(first part of a large selection)</span>}
          </>
        )}
      </span>
    </div>
  );
}
