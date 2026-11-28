/**
 * The name box: shows the active cell or range and goes to a typed cell,
 * range or defined name. It sits over the grid's own address box (see
 * styles.css), which accepts addresses only.
 */
import { useId, useMemo, useState } from "react";
import type { GridSelection, SheetGridController } from "../grid";
import { formatA1, formatA1Range } from "../session/engine";
import { goToNames, resolveGoTo } from "./name-box";

export interface NameBoxProps {
  controller: SheetGridController;
  selection: GridSelection;
  /** Content revision, so the list of names follows edits. */
  revision: number;
  onFailure: (message: string) => void;
}

function describe(selection: GridSelection): string {
  const last = selection.ranges[selection.ranges.length - 1];
  if (last === undefined || last.kind !== "cells") return formatA1(selection.active);
  return formatA1Range(last);
}

export function NameBox({ controller, selection, revision, onFailure }: NameBoxProps) {
  const listId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const workbook = controller.session.workbook;
  // `revision` invalidates the list when names change with an edit or reload.
  const names = useMemo(() => (revision >= 0 ? goToNames(workbook, selection.sheet) : []), [workbook, selection.sheet, revision]);

  const go = (text: string): void => {
    const target = resolveGoTo(workbook, selection.sheet, text);
    if (!target.ok) {
      onFailure(target.message);
      return;
    }
    setDraft(null);
    controller.select(target.range, target.sheet);
    controller.focus();
  };

  return (
    <>
      <input
        className="sheets-namebox"
        type="text"
        aria-label="Name box. Type a cell, a range or a name and press Enter to go there."
        spellCheck={false}
        autoComplete="off"
        list={names.length > 0 ? listId : undefined}
        value={draft ?? describe(selection)}
        maxLength={300}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={() => setDraft(null)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            go(event.currentTarget.value);
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(null);
            controller.focus();
          }
        }}
      />
      {names.length > 0 && (
        <datalist id={listId}>
          {names.map((name) => (
            <option key={`${name.scope ?? ""}:${name.name}`} value={name.name}>
              {name.refersTo}
            </option>
          ))}
        </datalist>
      )}
    </>
  );
}
