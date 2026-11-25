/** The Insert, Formulas, Data, Review, View and Assistant tabs. */
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Bot,
  Calculator,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Columns3,
  CopyX,
  Eraser,
  Filter,
  Grid2x2,
  Highlighter,
  ListChecks,
  Network,
  Rows3,
  ScanSearch,
  Sheet,
  Sigma,
  Snowflake,
  Sparkles,
  Split,
  SquareFunction,
  Table2,
  Tag,
  TextCursorInput,
  Waypoints,
  X,
  XCircle,
} from "lucide-react";
import type { RibbonPanelTab } from "../../../../_shared/office-ui";
import type { SheetCommands } from "./commands";
import { SPLIT_DELIMITERS } from "./data-tools";
import { AUTOSUM_FUNCTIONS } from "./formula-tools";
import { type RibbonModel, commandButton as button, commandToggle as toggle } from "./model";

const ICON = 16;
const BIG = 20;

export function insertTab(cmd: SheetCommands): RibbonPanelTab {
  return {
    id: "insert",
    label: "Insert",
    groups: [
      {
        id: "insert-cells",
        label: "Cells",
        items: [
          {
            kind: "menu",
            id: "insert-rows",
            label: "Rows",
            size: "large",
            icon: <Rows3 size={BIG} />,
            menu: [
              { id: "above", label: "Insert row above" },
              { id: "below", label: "Insert row below" },
            ],
            onMenuSelect: (id) => cmd["insert-rows"](id),
          },
          {
            kind: "menu",
            id: "insert-columns",
            label: "Columns",
            size: "large",
            icon: <Columns3 size={BIG} />,
            menu: [
              { id: "left", label: "Insert column left" },
              { id: "right", label: "Insert column right" },
            ],
            onMenuSelect: (id) => cmd["insert-columns"](id),
          },
        ],
      },
      { id: "insert-sheets", label: "Sheets", items: [button(cmd, "insert-sheet", "Sheet", <Sheet size={BIG} />, { size: "large" })] },
      { id: "insert-functions", label: "Functions", items: [button(cmd, "insert-function", "Function", <SquareFunction size={BIG} />, { size: "large" })] },
    ],
  };
}

export function formulasTab(cmd: SheetCommands, model: RibbonModel): RibbonPanelTab {
  return {
    id: "formulas",
    label: "Formulas",
    groups: [
      {
        id: "functions",
        label: "Function library",
        items: [
          button(cmd, "insert-function", "Insert function", <SquareFunction size={BIG} />, { size: "large" }),
          {
            kind: "split",
            id: "autosum",
            label: "AutoSum",
            size: "large",
            icon: <Sigma size={BIG} />,
            menu: AUTOSUM_FUNCTIONS.map((fn) => ({ id: fn, label: fn === "SUM" ? "Sum" : fn === "AVERAGE" ? "Average" : fn === "COUNT" ? "Count numbers" : fn === "MIN" ? "Min" : "Max" })),
            onClick: () => cmd.autosum("SUM"),
            onMenuSelect: (fn) => cmd.autosum(fn),
          },
        ],
      },
      {
        id: "names",
        label: "Defined names",
        items: [
          {
            kind: "menu",
            id: "defined-names",
            label: "Go to name",
            size: "large",
            icon: <Tag size={BIG} />,
            disabled: model.names.length === 0,
            menu: model.names.map((name) => ({ id: name, label: name })),
            onMenuSelect: (name) => cmd["defined-names"](name),
          },
        ],
      },
      {
        id: "auditing",
        label: "Formula auditing",
        items: [
          {
            kind: "stack",
            id: "auditing-rows",
            rows: [
              [button(cmd, "trace-precedents", "Trace precedents", <Waypoints size={ICON} />, { showLabel: true })],
              [button(cmd, "trace-dependents", "Trace dependents", <Network size={ICON} />, { showLabel: true })],
              [button(cmd, "trace-clear", "Remove arrows", <Eraser size={ICON} />, { showLabel: true })],
            ],
          },
        ],
      },
      { id: "calculation", label: "Calculation", items: [button(cmd, "recalculate", "Calculate now", <Calculator size={BIG} />, { size: "large" })] },
    ],
  };
}

export function dataTab(cmd: SheetCommands, model: RibbonModel): RibbonPanelTab {
  return {
    id: "data",
    label: "Data",
    groups: [
      {
        id: "sort-filter",
        label: "Sort and filter",
        items: [
          {
            kind: "stack",
            id: "sort-rows",
            rows: [
              [button(cmd, "sort-asc", "Sort A to Z", <ArrowUpNarrowWide size={ICON} />, { showLabel: true })],
              [button(cmd, "sort-desc", "Sort Z to A", <ArrowDownWideNarrow size={ICON} />, { showLabel: true })],
            ],
          },
          toggle(cmd, "filter-toggle", "Filter by selected value", <Filter size={BIG} />, model.filtered, { size: "large" }),
        ],
      },
      {
        id: "data-tools",
        label: "Data tools",
        items: [
          button(cmd, "remove-duplicates", "Remove duplicates", <CopyX size={BIG} />, { size: "large" }),
          {
            kind: "menu",
            id: "text-to-columns",
            label: "Text to columns",
            size: "large",
            icon: <Split size={BIG} />,
            menu: SPLIT_DELIMITERS.map((entry) => ({ id: entry.id, label: `Split at ${entry.label.toLowerCase()}` })),
            onMenuSelect: (id) => cmd["text-to-columns"](id),
          },
        ],
      },
    ],
  };
}

export function reviewTab(cmd: SheetCommands, model: RibbonModel): RibbonPanelTab {
  const none = model.review.total === 0;
  const noCurrent = model.review.currentId === null;
  return {
    id: "review",
    label: "Review",
    groups: [
      {
        id: "changes",
        label: model.review.total > 0 ? `Changes (${model.review.total})` : "Changes",
        items: [
          toggle(cmd, "review-panel", "Review panel", <ListChecks size={BIG} />, model.panel === "review", { size: "large" }),
          toggle(cmd, "review-markup", "Show markup", <Highlighter size={BIG} />, model.review.markup, { size: "large" }),
        ],
      },
      {
        id: "navigate",
        label: "Go to",
        items: [
          {
            kind: "stack",
            id: "navigate-rows",
            rows: [
              [button(cmd, "change-previous", "Previous change", <ChevronLeft size={ICON} />, { showLabel: true, disabled: none })],
              [button(cmd, "change-next", "Next change", <ChevronRight size={ICON} />, { showLabel: true, disabled: none })],
            ],
          },
        ],
      },
      {
        id: "resolve",
        label: "Accept or reject",
        items: [
          button(cmd, "change-accept", "Accept change", <Check size={BIG} />, { size: "large", disabled: noCurrent }),
          button(cmd, "change-reject", "Reject change", <X size={BIG} />, { size: "large", disabled: noCurrent }),
          {
            kind: "stack",
            id: "resolve-all-rows",
            rows: [
              [button(cmd, "change-accept-all", "Accept all", <CheckCheck size={ICON} />, { showLabel: true, disabled: none })],
              [button(cmd, "change-reject-all", "Reject all", <XCircle size={ICON} />, { showLabel: true, disabled: none })],
            ],
          },
        ],
      },
    ],
  };
}

export function viewTab(cmd: SheetCommands, model: RibbonModel): RibbonPanelTab {
  return {
    id: "view",
    label: "View",
    groups: [
      {
        id: "window",
        label: "Window",
        items: [
          {
            kind: "menu",
            id: "freeze",
            label: "Freeze panes",
            size: "large",
            icon: <Snowflake size={BIG} />,
            menu: [
              { id: "selection", label: "Freeze above and left of the selection" },
              { id: "row", label: "Freeze top row" },
              { id: "column", label: "Freeze first column" },
              { id: "none", label: "Unfreeze", separatorBefore: true },
            ],
            onMenuSelect: (id) => cmd.freeze(id),
          },
        ],
      },
      {
        id: "show",
        label: "Show",
        items: [
          toggle(cmd, "formula-bar", "Formula bar", <TextCursorInput size={BIG} />, model.view.formulaBar, { size: "large" }),
          toggle(cmd, "gridlines", "Gridlines", <Grid2x2 size={BIG} />, model.view.gridlines, { size: "large" }),
        ],
      },
    ],
  };
}

export function assistantTab(cmd: SheetCommands, model: RibbonModel): RibbonPanelTab {
  const offline = !model.aiAvailable || model.assistantBusy;
  return {
    id: "assistant",
    label: "Assistant",
    groups: [
      { id: "assistant-open", label: "Assistant", items: [toggle(cmd, "assistant-panel", "Assistant panel", <Bot size={BIG} />, model.panel === "assistant", { size: "large" })] },
      {
        id: "assistant-quick",
        label: "Quick actions",
        items: [
          button(cmd, "assistant-explain", "Explain selection", <Sparkles size={BIG} />, { size: "large", disabled: offline }),
          button(cmd, "assistant-trace", "Trace value", <ScanSearch size={BIG} />, { size: "large", disabled: offline }),
          button(cmd, "assistant-check", "Check hard-coded values", <ListChecks size={BIG} />, { size: "large", disabled: model.assistantBusy }),
          button(cmd, "assistant-format-table", "Format as table", <Table2 size={BIG} />, { size: "large", disabled: model.assistantBusy }),
        ],
      },
    ],
  };
}
