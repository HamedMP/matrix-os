/** Find and replace bar over the active sheet. Matches are marked in the grid. */
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Checkbox, Select } from "../../../_shared/office-ui";
import type { CellDecoration, GridSelection, SheetGridController } from "../grid";
import type { SheetSession } from "../session/session";
import { type FindOptions, MAX_QUERY_LENGTH, findMatches, nextMatch, planReplaceAll, replaceEdit } from "./find-replace";

export interface FindReplaceProps {
  session: SheetSession;
  controller: SheetGridController;
  selection: GridSelection;
  revision: number;
  /** Shows the replace row. */
  showReplace: boolean;
  onToggleReplace: () => void;
  onClose: () => void;
  onMessage: (message: string, tone?: "info" | "success" | "warning") => void;
}

const LAYER = "search";
/** Most matches marked in the grid at once. */
const MAX_MARKED = 2_000;

export function FindReplace({ session, controller, selection, revision, showReplace, onToggleReplace, onClose, onMessage }: FindReplaceProps) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeCell, setWholeCell] = useState(false);
  const [lookIn, setLookIn] = useState<FindOptions["lookIn"]>("values");
  const input = useRef<HTMLInputElement | null>(null);
  const sheet = selection.sheet;

  const options = useMemo<FindOptions>(() => ({ query, matchCase, wholeCell, lookIn }), [query, matchCase, wholeCell, lookIn]);
  // `revision` re-runs the search after edits.
  const found = useMemo(() => (revision >= 0 ? findMatches(session, sheet, options) : { matches: [], truncated: false }), [session, sheet, options, revision]);
  const { matches } = found;
  const active = selection.active;
  const current = matches.findIndex((m) => m.row === active.row && m.col === active.col);

  useEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    const marks: CellDecoration[] = matches.slice(0, MAX_MARKED).map((m, index) => ({ sheet, row: m.row, col: m.col, kind: index === current ? "search-active" : "search" }));
    controller.decorate(LAYER, marks);
  }, [controller, matches, current, sheet]);

  useEffect(() => () => controller.clearDecorations(LAYER), [controller]);

  const go = (backwards: boolean): void => {
    if (matches.length === 0) {
      if (query !== "") onMessage("No cells match.", "info");
      return;
    }
    const index = nextMatch(matches, active, backwards);
    const target = matches[index];
    if (target !== undefined) controller.select({ row: target.row, col: target.col });
  };

  const replaceCurrent = (): void => {
    const target = current >= 0 ? matches[current] : undefined;
    if (target === undefined) {
      go(false);
      return;
    }
    const edit = replaceEdit(session, sheet, target, options, replacement);
    if (edit === null) {
      onMessage("This cell shows a formula result, which cannot be replaced. Look in formulas instead.", "warning");
      go(false);
      return;
    }
    const result = session.applyEdits([edit], "Replace");
    if (!result.ok) {
      onMessage(result.message, "warning");
      return;
    }
    go(false);
  };

  const replaceEvery = (): void => {
    const plan = planReplaceAll(session, sheet, options, replacement);
    if (plan.edits.length === 0) {
      onMessage(plan.skipped > 0 ? "The matching cells show formula results, which cannot be replaced." : "No cells match.", "info");
      return;
    }
    const result = session.applyEdits(plan.edits, "Replace all");
    if (!result.ok) {
      onMessage(result.message, "warning");
      return;
    }
    const skipped = plan.skipped > 0 ? ` ${plan.skipped} formula ${plan.skipped === 1 ? "result was" : "results were"} left as they are.` : "";
    onMessage(`Replaced in ${plan.edits.length} ${plan.edits.length === 1 ? "cell" : "cells"}.${skipped}`, "success");
  };

  // Replacing changes cells: the text still in the cell editor goes in first, and a refused one stops it.
  const replaceOne = (): void => void controller.afterEdit(replaceCurrent);
  const replaceAll = (): void => void controller.afterEdit(replaceEvery);

  const count = query === "" ? "" : matches.length === 0 ? "No matches" : `${current >= 0 ? current + 1 : "-"} of ${matches.length}${found.truncated ? "+" : ""}`;

  return (
    <search
      className="sheets-find"
      aria-label="Find and replace"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
          controller.focus();
        }
      }}
    >
      <div className="sheets-find__row">
        <input
          ref={input}
          className="sheets-find__input"
          type="search"
          aria-label="Find"
          placeholder="Find in sheet"
          maxLength={MAX_QUERY_LENGTH}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              go(event.shiftKey);
            }
          }}
        />
        <span className="sheets-find__count" aria-live="polite">
          {count}
        </span>
        <button type="button" className="sheets-icon-btn" aria-label="Previous match" onClick={() => go(true)}>
          <ChevronUp size={16} />
        </button>
        <button type="button" className="sheets-icon-btn" aria-label="Next match" onClick={() => go(false)}>
          <ChevronDown size={16} />
        </button>
        <Checkbox label="Match case" checked={matchCase} onChange={setMatchCase} />
        <Checkbox label="Whole cell" checked={wholeCell} onChange={setWholeCell} />
        <Select
          label="Look in"
          hideLabel
          value={lookIn}
          onChange={(value) => setLookIn(value === "formulas" ? "formulas" : "values")}
          options={[
            { value: "values", label: "Values" },
            { value: "formulas", label: "Formulas" },
          ]}
        />
        <button type="button" className="oui-button oui-button--ghost" aria-expanded={showReplace} onClick={onToggleReplace}>
          {showReplace ? "Hide replace" : "Replace"}
        </button>
        <button
          type="button"
          className="sheets-icon-btn"
          aria-label="Close find and replace"
          onClick={() => {
            onClose();
            controller.focus();
          }}
        >
          <X size={16} />
        </button>
      </div>
      {showReplace && (
        <div className="sheets-find__row">
          <input
            className="sheets-find__input"
            type="text"
            aria-label="Replace with"
            placeholder="Replace with"
            maxLength={MAX_QUERY_LENGTH}
            value={replacement}
            onChange={(event) => setReplacement(event.currentTarget.value)}
          />
          <button type="button" className="oui-button oui-button--ghost" disabled={query === ""} onClick={replaceOne}>
            Replace
          </button>
          <button type="button" className="oui-button oui-button--ghost" disabled={query === ""} onClick={replaceAll}>
            Replace all
          </button>
        </div>
      )}
    </search>
  );
}
