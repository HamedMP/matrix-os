import { useCallback } from "react";
import {
  applyFilter,
  clearSelection,
  deleteColumns,
  deleteRows,
  filterByActiveValue,
  insertColumns,
  insertRows,
  sortSelection,
} from "./actions-data";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import type { GridContext } from "./context";
import type { MenuState } from "./store";
import { clickCopy, clickPaste } from "./click-clipboard";

const CLIPBOARD_BLOCKED = "The browser did not let the menu read the clipboard. Press Ctrl+V to paste.";
const COPIED_HERE = "Kept for pasting in this workbook. To paste in another app, use Ctrl+C or Ctrl+X.";

function itemsFor(menu: MenuState, readOnly: boolean, filtered: boolean): MenuItem[] {
  const items: MenuItem[] = [
    { id: "cut", label: "Cut", disabled: readOnly },
    { id: "copy", label: "Copy" },
    { id: "paste", label: "Paste", disabled: readOnly },
    { id: "clear", label: "Clear contents", disabled: readOnly },
  ];
  if (menu.area !== "cols") {
    items.push(
      { id: "row-above", label: "Insert rows above", separated: true, disabled: readOnly },
      { id: "row-below", label: "Insert rows below", disabled: readOnly },
      { id: "row-delete", label: "Delete rows", disabled: readOnly },
    );
  }
  if (menu.area !== "rows") {
    items.push(
      { id: "col-left", label: "Insert columns left", separated: true, disabled: readOnly },
      { id: "col-right", label: "Insert columns right", disabled: readOnly },
      { id: "col-delete", label: "Delete columns", disabled: readOnly },
    );
  }
  items.push(
    { id: "sort-asc", label: "Sort A to Z", separated: true, disabled: readOnly },
    { id: "sort-desc", label: "Sort Z to A", disabled: readOnly },
    { id: "filter-value", label: "Filter by this value" },
    { id: "filter-clear", label: "Clear filter", disabled: !filtered },
  );
  return items;
}

export interface GridMenuProps {
  ctx: GridContext;
  menu: MenuState;
  readOnly: boolean;
  /** Returns the keyboard focus to the grid after the menu closes. */
  onDone(): void;
}

/** The context menu of the cells and headers. */
export function GridMenu({ ctx, menu, readOnly, onDone }: GridMenuProps) {
  const close = useCallback(() => {
    ctx.store.set({ menu: null });
    onDone();
  }, [ctx, onDone]);

  const pick = (id: string): void => {
    close();
    switch (id) {
      case "cut":
      case "copy":
        void clickCopy(ctx, id === "cut").then((outcome) => {
          if (outcome === "own") ctx.notice(COPIED_HERE);
        });
        return;
      case "paste":
        void clickPaste(ctx).then((outcome) => {
          if (outcome === "blocked") ctx.notice(CLIPBOARD_BLOCKED);
        });
        return;
      case "clear":
        clearSelection(ctx);
        return;
      case "row-above":
        insertRows(ctx, "before");
        return;
      case "row-below":
        insertRows(ctx, "after");
        return;
      case "row-delete":
        deleteRows(ctx);
        return;
      case "col-left":
        insertColumns(ctx, "before");
        return;
      case "col-right":
        insertColumns(ctx, "after");
        return;
      case "col-delete":
        deleteColumns(ctx);
        return;
      case "sort-asc":
        sortSelection(ctx, false);
        return;
      case "sort-desc":
        sortSelection(ctx, true);
        return;
      case "filter-value":
        filterByActiveValue(ctx);
        return;
      case "filter-clear":
        applyFilter(ctx, null);
        return;
      default:
        return;
    }
  };

  return <ContextMenu items={itemsFor(menu, readOnly, ctx.view.filter !== null)} x={menu.x} y={menu.y} label="Cell actions" onPick={pick} onClose={close} />;
}
