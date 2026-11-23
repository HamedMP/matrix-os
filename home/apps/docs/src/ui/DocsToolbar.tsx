/** The ribbon: history, paragraph style, character format, review, view, find, zoom and export. */

import { Bold, Download, Eye, FileEdit, Italic, Redo2, Search, Strikethrough, Underline, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import type { ParagraphStylePatch } from "../../../_shared/office-engine/index";
import { Dropdown, Toolbar, ToolbarButton, ToolbarGroup, ToolbarSeparator, useToast } from "../../../_shared/office-ui";
import type { ActiveFormat, DocumentEditorController, ToggleFormat, ViewMode } from "../editor/index";
import type { SessionState } from "../session/index";
import type { ExportFormat } from "./exports";

const ZOOM_LEVELS = [50, 75, 90, 100, 110, 125, 150, 175, 200] as const;

interface StyleChoice {
  id: string;
  label: string;
  patch: Partial<ParagraphStylePatch>;
}

const STYLES: readonly StyleChoice[] = [
  { id: "normal", label: "Normal", patch: { headingLevel: 0 } },
  { id: "title", label: "Title", patch: { styleId: "Title" } },
  { id: "h1", label: "Heading 1", patch: { headingLevel: 1 } },
  { id: "h2", label: "Heading 2", patch: { headingLevel: 2 } },
  { id: "h3", label: "Heading 3", patch: { headingLevel: 3 } },
  { id: "list", label: "List paragraph", patch: { styleId: "ListParagraph" } },
];

const VIEW_LABELS: Record<ViewMode, string> = { markup: "All markup", final: "Final", original: "Original" };

function currentStyle(format: ActiveFormat | null): string {
  if (format === null || format.headingLevel === null) return "Style";
  if (format.headingLevel > 0) return `Heading ${format.headingLevel}`;
  if (format.styleName === "Title") return "Title";
  if (format.styleName === "List Paragraph") return "List paragraph";
  return "Normal";
}

export interface DocsToolbarProps {
  editor: DocumentEditorController | null;
  state: SessionState;
  activeFormat: ActiveFormat | null;
  readOnly: boolean;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  findOpen: boolean;
  onToggleFind: () => void;
  onExport: (format: ExportFormat) => void;
}

export function DocsToolbar(props: DocsToolbarProps) {
  const { editor, state, activeFormat, readOnly, viewMode, onViewModeChange, zoom, onZoomChange, findOpen, onToggleFind, onExport } = props;
  const toast = useToast();
  const disabled = editor === null || readOnly;

  const toggle = (format: ToggleFormat) => {
    if (editor === null) return;
    editor.format(format);
    editor.focus();
  };

  const applyStyle = (id: string) => {
    const choice = STYLES.find((style) => style.id === id);
    if (choice === undefined || editor === null) return;
    if (!editor.setParagraphStyle(choice.patch)) {
      toast.show({ title: `Could not apply ${choice.label}`, description: "Place the cursor in the document first, or this document has no such style.", tone: "warning" });
    }
    editor.focus();
  };

  const zoomIndex = ZOOM_LEVELS.indexOf(zoom as (typeof ZOOM_LEVELS)[number]);
  const step = (direction: number) => {
    const at = zoomIndex < 0 ? ZOOM_LEVELS.indexOf(100) : zoomIndex;
    const next = ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, Math.max(0, at + direction))];
    if (next !== undefined) onZoomChange(next);
  };

  return (
    <Toolbar label="Document tools" className="docs-ribbon">
      <ToolbarGroup label="History">
        <ToolbarButton label="Undo" icon={<Undo2 size={16} />} shortcut="Ctrl+Z" disabled={!state.canUndo || editor === null} onClick={() => editor?.undo()} />
        <ToolbarButton label="Redo" icon={<Redo2 size={16} />} shortcut="Ctrl+Y" disabled={!state.canRedo || editor === null} onClick={() => editor?.redo()} />
      </ToolbarGroup>
      <ToolbarSeparator />
      <ToolbarGroup label="Paragraph">
        <Dropdown
          label={currentStyle(activeFormat)}
          ariaLabel="Paragraph style"
          disabled={disabled}
          items={STYLES.map((style) => ({ id: style.id, label: style.label, checked: currentStyle(activeFormat) === style.label }))}
          onSelect={applyStyle}
        />
      </ToolbarGroup>
      <ToolbarGroup label="Character">
        <ToolbarButton label="Bold" icon={<Bold size={16} />} shortcut="Ctrl+B" pressed={activeFormat?.bold ?? false} disabled={disabled} onClick={() => toggle("bold")} />
        <ToolbarButton label="Italic" icon={<Italic size={16} />} shortcut="Ctrl+I" pressed={activeFormat?.italic ?? false} disabled={disabled} onClick={() => toggle("italic")} />
        <ToolbarButton label="Underline" icon={<Underline size={16} />} shortcut="Ctrl+U" pressed={activeFormat?.underline ?? false} disabled={disabled} onClick={() => toggle("underline")} />
        <ToolbarButton label="Strikethrough" icon={<Strikethrough size={16} />} pressed={activeFormat?.strike ?? false} disabled={disabled} onClick={() => toggle("strike")} />
      </ToolbarGroup>
      <ToolbarSeparator />
      <ToolbarGroup label="Review">
        <ToolbarButton label="Track changes" icon={<FileEdit size={16} />} showLabel pressed={state.tracking} disabled={editor === null} onClick={() => editor?.setTracking(!state.tracking)} />
        <Dropdown
          label={
            <>
              <Eye size={16} aria-hidden="true" /> {VIEW_LABELS[viewMode]}
            </>
          }
          ariaLabel={`View: ${VIEW_LABELS[viewMode]}`}
          items={(Object.keys(VIEW_LABELS) as ViewMode[]).map((mode) => ({ id: mode, label: VIEW_LABELS[mode], checked: mode === viewMode }))}
          onSelect={(id) => onViewModeChange(id as ViewMode)}
        />
      </ToolbarGroup>
      <ToolbarSeparator />
      <ToolbarGroup label="Find and view">
        <ToolbarButton label="Find and replace" icon={<Search size={16} />} shortcut="Ctrl+F" pressed={findOpen} onClick={onToggleFind} />
        <ToolbarButton label="Zoom out" icon={<ZoomOut size={16} />} disabled={zoom <= ZOOM_LEVELS[0]} onClick={() => step(-1)} />
        <Dropdown
          label={`${zoom}%`}
          ariaLabel={`Zoom ${zoom}%`}
          items={ZOOM_LEVELS.map((level) => ({ id: String(level), label: `${level}%`, checked: level === zoom }))}
          onSelect={(id) => onZoomChange(Number(id))}
        />
        <ToolbarButton label="Zoom in" icon={<ZoomIn size={16} />} disabled={zoom >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1]} onClick={() => step(1)} />
      </ToolbarGroup>
      <ToolbarSeparator />
      <ToolbarGroup label="Export">
        <Dropdown
          label={
            <>
              <Download size={16} aria-hidden="true" /> Export
            </>
          }
          ariaLabel="Export"
          disabled={editor === null}
          items={[
            { id: "html", label: "HTML (.html)" },
            { id: "markdown", label: "Markdown (.md)" },
            { id: "text", label: "Plain text (.txt)" },
          ]}
          onSelect={(id) => onExport(id as ExportFormat)}
        />
      </ToolbarGroup>
    </Toolbar>
  );
}
