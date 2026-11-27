/** The Insert, Review, View and Assistant tabs. */

import {
  ArrowDownToLine,
  ArrowUpToLine,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CornerDownLeft,
  FileEdit,
  GitCompareArrows,
  ListChecks,
  MessageSquarePlus,
  PanelLeft,
  PanelRight,
  Pilcrow,
  Sparkles,
  TableRowsSplit,
  WrapText,
  X,
  XCircle,
  ZoomIn,
  ZoomOut,
  ArrowRightToLine,
  SearchCheck,
} from "lucide-react";
import type { RibbonPanelTab } from "../../../../_shared/office-ui";
import { QUICK_ACTIONS } from "../../agent/quick-actions";
import type { ViewMode } from "../../editor/index";
import type { DocsRibbonContext } from "./types";

export const ZOOM_LEVELS = [50, 75, 90, 100, 110, 125, 150, 175, 200] as const;

export const VIEW_LABELS: Record<ViewMode, string> = { markup: "All markup", final: "Final", original: "Original" };

/** The next zoom preset in a direction, from the current zoom. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_LEVELS.find((level) => level > zoom) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1]!;
  return [...ZOOM_LEVELS].reverse().find((level) => level < zoom) ?? ZOOM_LEVELS[0];
}

export function insertTab({ state, actions }: DocsRibbonContext): RibbonPanelTab {
  const off = !state.editable;
  const row = state.caret?.row ?? null;
  return {
    id: "insert",
    label: "Insert",
    groups: [
      {
        id: "breaks",
        label: "Breaks",
        items: [
          { kind: "button", id: "insert-paragraph", label: "Paragraph break", shortcut: "Enter", size: "large", icon: <Pilcrow size={20} />, disabled: off, onClick: actions.insertParagraph },
          {
            kind: "stack",
            id: "break-rows",
            rows: [
              [{ kind: "button", id: "insert-line-break", label: "Line break", shortcut: "Shift+Enter", icon: <CornerDownLeft size={16} />, disabled: off, onClick: () => actions.insertText("\n") }],
              [{ kind: "button", id: "insert-tab", label: "Tab", shortcut: "Tab", icon: <ArrowRightToLine size={16} />, disabled: off, onClick: () => actions.insertText("\t") }],
            ],
          },
        ],
      },
      {
        id: "table",
        label: "Table",
        icon: <TableRowsSplit size={16} />,
        items: [
          { kind: "button", id: "row-above", label: "Insert row above", icon: <ArrowUpToLine size={16} />, disabled: off || row === null, onClick: () => actions.insertTableRow("above") },
          { kind: "button", id: "row-below", label: "Insert row below", icon: <ArrowDownToLine size={16} />, disabled: off || row === null, onClick: () => actions.insertTableRow("below") },
          { kind: "button", id: "row-delete", label: "Delete row", icon: <X size={16} />, disabled: off || row === null || row.rowCount <= 1, onClick: actions.deleteTableRow },
        ],
      },
      {
        id: "insert-comments",
        label: "Comments",
        items: [{ kind: "button", id: "insert-comment", label: "Comment", shortcut: "Alt+Shift+M", size: "large", icon: <MessageSquarePlus size={20} />, disabled: off, onClick: actions.newComment }],
      },
    ],
  };
}

export function reviewTab({ state, actions }: DocsRibbonContext): RibbonPanelTab {
  const off = !state.editable;
  const none = state.revisions.shown === 0;
  return {
    id: "review",
    label: "Review",
    groups: [
      {
        id: "tracking",
        label: "Tracking",
        items: [
          { kind: "toggle", id: "track-changes", label: "Track changes", size: "large", icon: <FileEdit size={20} />, pressed: state.tracking, disabled: !state.hasEditor, onToggle: actions.setTracking },
          {
            kind: "select",
            id: "markup-view",
            label: "Markup view",
            width: 116,
            value: state.viewMode,
            options: (Object.keys(VIEW_LABELS) as ViewMode[]).map((mode) => ({ value: mode, label: VIEW_LABELS[mode] })),
            disabled: !state.hasEditor,
            onChange: (value) => actions.setViewMode(value as ViewMode),
          },
        ],
      },
      {
        id: "changes",
        label: "Changes",
        icon: <ListChecks size={16} />,
        items: [
          {
            kind: "stack",
            id: "change-steps",
            rows: [
              [{ kind: "button", id: "change-previous", label: "Previous change", shortcut: "Alt+Shift+P", icon: <ChevronLeft size={16} />, disabled: none, onClick: actions.previousChange }],
              [{ kind: "button", id: "change-next", label: "Next change", shortcut: "Alt+Shift+N", icon: <ChevronRight size={16} />, disabled: none, onClick: actions.nextChange }],
            ],
          },
          {
            kind: "stack",
            id: "change-accept",
            rows: [
              [{ kind: "button", id: "change-accept", label: "Accept", shortcut: "Alt+Shift+A", icon: <Check size={16} />, disabled: off || none, onClick: actions.acceptChange }],
              [{ kind: "button", id: "change-reject", label: "Reject", shortcut: "Alt+Shift+R", icon: <XCircle size={16} />, disabled: off || none, onClick: actions.rejectChange }],
            ],
          },
          {
            kind: "stack",
            id: "change-all",
            rows: [
              [{ kind: "button", id: "accept-all", label: "Accept all", icon: <CheckCheck size={16} />, disabled: off || none, onClick: actions.acceptAll }],
              [{ kind: "button", id: "reject-all", label: "Reject all", icon: <X size={16} />, disabled: off || none, onClick: actions.rejectAll }],
            ],
          },
        ],
      },
      {
        id: "review-comments",
        label: "Comments",
        items: [{ kind: "button", id: "new-comment", label: "New comment", shortcut: "Alt+Shift+M", size: "large", icon: <MessageSquarePlus size={20} />, disabled: off, onClick: actions.newComment }],
      },
      {
        id: "compare",
        label: "Compare",
        items: [{ kind: "button", id: "compare", label: "Compare", size: "large", icon: <GitCompareArrows size={20} />, disabled: !state.hasEditor, onClick: () => actions.openPanel("compare") }],
      },
      {
        id: "review-pane",
        label: "Pane",
        items: [{ kind: "toggle", id: "review-panel", label: "Review panel", size: "large", icon: <ListChecks size={20} />, pressed: state.panel === "review", onToggle: (next) => (next ? actions.openPanel("review") : actions.togglePanel()) }],
      },
    ],
  };
}

export function viewTab({ state, actions }: DocsRibbonContext): RibbonPanelTab {
  const min = ZOOM_LEVELS[0];
  const max = ZOOM_LEVELS[ZOOM_LEVELS.length - 1]!;
  return {
    id: "view",
    label: "View",
    groups: [
      {
        id: "zoom",
        label: "Zoom",
        icon: <ZoomIn size={16} />,
        items: [
          { kind: "button", id: "zoom-out", label: "Zoom out", icon: <ZoomOut size={16} />, showLabel: false, disabled: state.zoom <= min, onClick: () => actions.setZoom(stepZoom(state.zoom, -1)) },
          {
            kind: "select",
            id: "zoom-level",
            label: "Zoom",
            width: 76,
            value: String(state.zoom),
            options: ZOOM_LEVELS.map((level) => ({ value: String(level), label: `${level}%` })),
            onChange: (value) => actions.setZoom(Number(value)),
          },
          { kind: "button", id: "zoom-in", label: "Zoom in", icon: <ZoomIn size={16} />, showLabel: false, disabled: state.zoom >= max, onClick: () => actions.setZoom(stepZoom(state.zoom, 1)) },
          { kind: "button", id: "zoom-reset", label: "100%", icon: <SearchCheck size={16} />, disabled: state.zoom === 100, onClick: () => actions.setZoom(100) },
        ],
      },
      {
        id: "show",
        label: "Show",
        items: [
          { kind: "toggle", id: "show-outline", label: "Outline", size: "large", icon: <PanelLeft size={20} />, pressed: state.outlineOpen, onToggle: actions.toggleOutline },
          { kind: "toggle", id: "show-panel", label: "Side panel", size: "large", icon: <PanelRight size={20} />, pressed: state.panel !== null, onToggle: actions.togglePanel },
        ],
      },
    ],
  };
}

export function assistantTab({ state, actions }: DocsRibbonContext): RibbonPanelTab {
  return {
    id: "assistant",
    label: "Assistant",
    groups: [
      {
        id: "assistant-panel",
        label: "Assistant",
        items: [
          { kind: "toggle", id: "assistant-open", label: "Assistant", size: "large", icon: <Sparkles size={20} />, pressed: state.panel === "assistant", onToggle: (next) => (next ? actions.openPanel("assistant") : actions.togglePanel()) },
        ],
      },
      {
        id: "quick-actions",
        label: "Quick actions",
        icon: <Sparkles size={16} />,
        items: [
          ...QUICK_ACTIONS.map((action) => ({
            kind: "button" as const,
            id: `assistant-${action.id}`,
            label: action.label,
            icon: <WrapText size={16} />,
            // Summaries only read the document; the others propose changes or comments.
            disabled: !state.hasEditor || (action.kind !== "answer" && !state.editable),
            onClick: () => actions.assistant(action.id),
          })),
          { kind: "button", id: "assistant-explain", label: "Explain selection", icon: <Sparkles size={16} />, disabled: !state.hasSelection, onClick: () => actions.assistant("explain") },
          { kind: "button", id: "assistant-fix-numbering", label: "Fix numbering", icon: <ListChecks size={16} />, disabled: !state.editable, onClick: () => actions.assistant("fix-numbering") },
        ],
      },
    ],
  };
}
