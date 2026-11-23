/** Runs a grid command (see `./keymap.ts`) against the session and the grid state. */

import { clearCopyMark } from "./actions-clipboard";
import { clearSelection, fillSelection, report, toggleFormat } from "./actions-data";
import { startEdit } from "./actions-edit";
import { advance, endMove, homeMove, moveActive, pageMove, selectActiveColumn, selectActiveRow, selectEverything } from "./actions-move";
import type { GridContext } from "./context";
import type { GridCommand } from "./keymap";

export function runGridCommand(ctx: GridContext, command: GridCommand): void {
  if (ctx.store.getState().notice !== null) ctx.notice(null);
  switch (command.type) {
    case "move":
      moveActive(ctx, command.direction, { extend: command.extend, jump: command.jump });
      return;
    case "page":
      pageMove(ctx, command.direction, command.extend);
      return;
    case "home":
      homeMove(ctx, command.extend, command.sheet);
      return;
    case "end":
      endMove(ctx, command.extend);
      return;
    case "tab":
      advance(ctx, command.back ? "left" : "right");
      return;
    case "enter":
      advance(ctx, command.back ? "up" : "down");
      return;
    case "edit":
      startEdit(ctx, command.initial);
      return;
    case "clear":
      clearSelection(ctx);
      return;
    case "undo":
      report(ctx, ctx.session.undo());
      return;
    case "redo":
      report(ctx, ctx.session.redo());
      return;
    case "selectAll":
      selectEverything(ctx);
      return;
    case "selectRow":
      selectActiveRow(ctx);
      return;
    case "selectColumn":
      selectActiveColumn(ctx);
      return;
    case "fill":
      fillSelection(ctx, command.direction);
      return;
    case "format":
      toggleFormat(ctx, command.toggle);
      return;
    case "escape":
      clearCopyMark(ctx);
      ctx.store.set({ menu: null, fill: null });
      return;
  }
}
