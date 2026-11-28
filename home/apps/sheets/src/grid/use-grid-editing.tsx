import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useRef } from "react";
import { acceptCompletion, argumentHint, completionView } from "./actions-edit";
import type { GridContext } from "./context";
import { FunctionPopup } from "./FunctionPopup";
import { handleEditorKey } from "./grid-keys";
import { optionId } from "./render-model";
import type { EditState } from "./store";

export interface GridEditing {
  /** Id of the highlighted entry of the function list, for `aria-activedescendant`. */
  activeOptionId: string | undefined;
  /** The function list and argument hint at a position, or null when no cell is edited. */
  popupAt(left: number, top: number): ReactNode;
  /** Key handler shared by the in-cell editor and the formula bar. */
  onKey(event: KeyboardEvent<HTMLTextAreaElement>): boolean;
}

/**
 * What the two text inputs share while a cell is edited: the function list,
 * the argument hint and the keys. It also gives the keyboard back to the grid
 * when editing ends, unless the owner has moved on to another part of the app.
 */
export function useGridEditing(
  ctx: GridContext,
  edit: EditState | null,
  listId: string,
  root: RefObject<HTMLElement | null>,
  focusGrid: () => void,
): GridEditing {
  const wasEditing = useRef(false);
  const editing = edit !== null;
  useEffect(() => {
    const document = root.current?.ownerDocument;
    if (wasEditing.current && !editing && document !== undefined) {
      const active = document.activeElement;
      if (active === null || active === document.body || root.current?.contains(active) === true) focusGrid();
    }
    wasEditing.current = editing;
  }, [editing, focusGrid, root]);

  const completion = editing ? completionView(ctx) : null;
  const hint = editing ? argumentHint(ctx) : null;
  const items = completion === null ? [] : completion.items;
  const index = completion === null ? 0 : completion.index;
  return {
    activeOptionId: completion === null ? undefined : optionId(listId, index),
    popupAt: (left, top) =>
      editing ? (
        <FunctionPopup
          listId={listId}
          items={items}
          activeIndex={index}
          summaryOf={(name) => ctx.catalog.hint(name)?.summary ?? ""}
          hint={hint}
          left={left}
          top={top}
          onPick={(name) => acceptCompletion(ctx, name)}
        />
      ) : null,
    onKey: (event) => handleEditorKey(ctx, event),
  };
}
