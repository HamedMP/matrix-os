/**
 * The formatting and structure toolbar. Every command acts on the grid
 * selection through the controller (or the session for presets), then puts
 * the keyboard focus back on the grid.
 */
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Baseline,
  BetweenHorizontalStart,
  BetweenVerticalStart,
  Bold,
  DecimalsArrowLeft,
  DecimalsArrowRight,
  Filter,
  Grid3x3,
  Italic,
  PaintBucket,
  Redo2,
  Search,
  Snowflake,
  TableCellsMerge,
  Underline,
  Undo2,
  WrapText,
} from "lucide-react";
import type { ReactNode } from "react";
import { Dropdown, Toolbar, ToolbarButton, ToolbarGroup, ToolbarSeparator } from "../../../_shared/office-ui";
import type { SheetGridController } from "../grid";
import type { CellStyle } from "../session/engine";
import type { EditResult, SessionState } from "../session/types";
import { NUMBER_FORMAT_PRESETS, changeDecimals, presetOf } from "./number-format";
import { BORDER_PRESETS, FILL_COLORS, FONT_FAMILIES, FONT_SIZES, TEXT_COLORS, type BorderPreset, type FreezePreset, applyBorders, applyFreeze } from "./ribbon-commands";

export interface RibbonProps {
  controller: SheetGridController;
  state: SessionState;
  /** Style of the active cell. */
  style: CellStyle;
  /** Shows a refused command's reason. */
  onFailure: (message: string) => void;
  onFind: () => void;
  readOnly?: boolean;
}

function Swatch({ color }: { color: string | null }) {
  return <span className={color === null ? "sheets-swatch sheets-swatch--none" : "sheets-swatch"} style={color === null ? undefined : { background: color }} aria-hidden="true" />;
}

function IconLabel({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <span className="sheets-ribbon__dd">
      {icon}
      <span className="sheets-sr-only">{text}</span>
    </span>
  );
}

export function Ribbon({ controller, state, style, onFailure, onFind, readOnly = false }: RibbonProps) {
  const run = (action: () => void): void => {
    action();
    controller.focus();
  };
  const check = (result: EditResult): void => {
    if (!result.ok) onFailure(result.message);
    controller.focus();
  };
  const align = style.alignment;
  const preset = presetOf(style.numberFormat);
  const disabled = readOnly;

  return (
    <Toolbar label="Spreadsheet formatting" className="sheets-ribbon">
      <ToolbarGroup label="History">
        <ToolbarButton label={state.undoLabel ? `Undo ${state.undoLabel}` : "Undo"} shortcut="Ctrl+Z" icon={<Undo2 size={16} />} disabled={disabled || !state.canUndo} onClick={() => check(controller.undo())} />
        <ToolbarButton label={state.redoLabel ? `Redo ${state.redoLabel}` : "Redo"} shortcut="Ctrl+Y" icon={<Redo2 size={16} />} disabled={disabled || !state.canRedo} onClick={() => check(controller.redo())} />
      </ToolbarGroup>
      <ToolbarSeparator />
      <ToolbarGroup label="Font">
        <Dropdown
          className="sheets-ribbon__font"
          label={<span className="sheets-ribbon__text">{style.font.name}</span>}
          ariaLabel={`Font, ${style.font.name}`}
          disabled={disabled}
          items={FONT_FAMILIES.map((name) => ({ id: name, label: name, checked: name === style.font.name }))}
          onSelect={(name) => run(() => controller.format({ font: { name } }))}
        />
        <Dropdown
          className="sheets-ribbon__size"
          label={<span className="sheets-ribbon__text">{style.font.sizePt}</span>}
          ariaLabel={`Font size, ${style.font.sizePt}`}
          disabled={disabled}
          items={FONT_SIZES.map((size) => ({ id: String(size), label: String(size), checked: size === style.font.sizePt }))}
          onSelect={(size) => run(() => controller.format({ font: { sizePt: Number(size) } }))}
        />
        <ToolbarButton label="Bold" shortcut="Ctrl+B" icon={<Bold size={16} />} pressed={style.font.bold} disabled={disabled} onClick={() => run(() => controller.toggleFormat("bold"))} />
        <ToolbarButton label="Italic" shortcut="Ctrl+I" icon={<Italic size={16} />} pressed={style.font.italic} disabled={disabled} onClick={() => run(() => controller.toggleFormat("italic"))} />
        <ToolbarButton label="Underline" shortcut="Ctrl+U" icon={<Underline size={16} />} pressed={style.font.underline} disabled={disabled} onClick={() => run(() => controller.toggleFormat("underline"))} />
        <Dropdown
          label={<IconLabel icon={<Baseline size={16} />} text="Text colour" />}
          ariaLabel="Text colour"
          disabled={disabled}
          items={TEXT_COLORS.map((item) => ({ id: item.id, label: item.label, icon: <Swatch color={item.color} />, checked: item.color === style.font.color }))}
          onSelect={(id) => run(() => controller.format({ font: { color: TEXT_COLORS.find((item) => item.id === id)?.color ?? null } }))}
        />
        <Dropdown
          label={<IconLabel icon={<PaintBucket size={16} />} text="Fill colour" />}
          ariaLabel="Fill colour"
          disabled={disabled}
          items={FILL_COLORS.map((item) => ({ id: item.id, label: item.label, icon: <Swatch color={item.color} />, checked: item.color === style.fill.color }))}
          onSelect={(id) => run(() => controller.format({ fill: { color: FILL_COLORS.find((item) => item.id === id)?.color ?? null } }))}
        />
        <Dropdown
          label={<IconLabel icon={<Grid3x3 size={16} />} text="Borders" />}
          ariaLabel="Borders"
          disabled={disabled}
          items={BORDER_PRESETS.map((item) => ({ id: item.id, label: item.label, separatorBefore: item.id === "none" }))}
          onSelect={(id) => check(applyBorders(controller, id as BorderPreset))}
        />
      </ToolbarGroup>
      <ToolbarSeparator />
      <ToolbarGroup label="Alignment">
        <ToolbarButton label="Align left" icon={<AlignLeft size={16} />} pressed={align.horizontal === "left"} disabled={disabled} onClick={() => run(() => controller.format({ alignment: { horizontal: align.horizontal === "left" ? "general" : "left" } }))} />
        <ToolbarButton label="Center" icon={<AlignCenter size={16} />} pressed={align.horizontal === "center"} disabled={disabled} onClick={() => run(() => controller.format({ alignment: { horizontal: align.horizontal === "center" ? "general" : "center" } }))} />
        <ToolbarButton label="Align right" icon={<AlignRight size={16} />} pressed={align.horizontal === "right"} disabled={disabled} onClick={() => run(() => controller.format({ alignment: { horizontal: align.horizontal === "right" ? "general" : "right" } }))} />
        <ToolbarButton label="Align top" icon={<AlignVerticalJustifyStart size={16} />} pressed={align.vertical === "top"} disabled={disabled} onClick={() => run(() => controller.format({ alignment: { vertical: "top" } }))} />
        <ToolbarButton label="Align middle" icon={<AlignVerticalJustifyCenter size={16} />} pressed={align.vertical === "middle"} disabled={disabled} onClick={() => run(() => controller.format({ alignment: { vertical: "middle" } }))} />
        <ToolbarButton label="Align bottom" icon={<AlignVerticalJustifyEnd size={16} />} pressed={align.vertical === "bottom"} disabled={disabled} onClick={() => run(() => controller.format({ alignment: { vertical: "bottom" } }))} />
        <ToolbarButton label="Wrap text" icon={<WrapText size={16} />} pressed={align.wrapText} disabled={disabled} onClick={() => run(() => controller.format({ alignment: { wrapText: !align.wrapText } }))} />
        <ToolbarButton label="Merge or unmerge cells" icon={<TableCellsMerge size={16} />} disabled={disabled} onClick={() => run(() => controller.toggleMerge())} />
      </ToolbarGroup>
      <ToolbarSeparator />
      <ToolbarGroup label="Number">
        <Dropdown
          className="sheets-ribbon__format"
          label={<span className="sheets-ribbon__text">{NUMBER_FORMAT_PRESETS.find((item) => item.id === preset)?.label ?? "Custom"}</span>}
          ariaLabel="Number format"
          disabled={disabled}
          items={NUMBER_FORMAT_PRESETS.map((item) => ({ id: item.id, label: item.label, checked: item.id === preset }))}
          onSelect={(id) => run(() => controller.format({ numberFormat: NUMBER_FORMAT_PRESETS.find((item) => item.id === id)?.code ?? "General" }))}
        />
        <ToolbarButton label="Increase decimals" icon={<DecimalsArrowRight size={16} />} disabled={disabled} onClick={() => run(() => controller.format({ numberFormat: changeDecimals(style.numberFormat, 1) }))} />
        <ToolbarButton label="Decrease decimals" icon={<DecimalsArrowLeft size={16} />} disabled={disabled} onClick={() => run(() => controller.format({ numberFormat: changeDecimals(style.numberFormat, -1) }))} />
      </ToolbarGroup>
      <ToolbarSeparator />
      <ToolbarGroup label="Rows and columns">
        <Dropdown
          label={<IconLabel icon={<BetweenHorizontalStart size={16} />} text="Rows" />}
          ariaLabel="Rows"
          disabled={disabled}
          items={[
            { id: "above", label: "Insert row above" },
            { id: "below", label: "Insert row below" },
            { id: "delete", label: "Delete rows", danger: true, separatorBefore: true },
          ]}
          onSelect={(id) => run(() => (id === "delete" ? controller.deleteRows() : controller.insertRows(id === "above" ? "before" : "after")))}
        />
        <Dropdown
          label={<IconLabel icon={<BetweenVerticalStart size={16} />} text="Columns" />}
          ariaLabel="Columns"
          disabled={disabled}
          items={[
            { id: "left", label: "Insert column left" },
            { id: "right", label: "Insert column right" },
            { id: "delete", label: "Delete columns", danger: true, separatorBefore: true },
          ]}
          onSelect={(id) => run(() => (id === "delete" ? controller.deleteColumns() : controller.insertColumns(id === "left" ? "before" : "after")))}
        />
      </ToolbarGroup>
      <ToolbarSeparator />
      <ToolbarGroup label="Data">
        <ToolbarButton label="Sort A to Z" icon={<ArrowUpNarrowWide size={16} />} disabled={disabled} onClick={() => run(() => controller.sort(false))} />
        <ToolbarButton label="Sort Z to A" icon={<ArrowDownWideNarrow size={16} />} disabled={disabled} onClick={() => run(() => controller.sort(true))} />
        <Dropdown
          label={<IconLabel icon={<Filter size={16} />} text="Filter" />}
          ariaLabel={controller.isFiltered ? "Filter, on" : "Filter"}
          items={[
            { id: "value", label: "Show rows with the selected value" },
            { id: "clear", label: "Show all rows", disabled: !controller.isFiltered },
          ]}
          onSelect={(id) => run(() => (id === "clear" ? controller.filter(null) : controller.filterByValue()))}
        />
        <Dropdown
          label={<IconLabel icon={<Snowflake size={16} />} text="Freeze panes" />}
          ariaLabel="Freeze panes"
          disabled={disabled}
          items={[
            { id: "selection", label: "Freeze above and left of the selection" },
            { id: "row", label: "Freeze top row" },
            { id: "column", label: "Freeze first column" },
            { id: "none", label: "Unfreeze", separatorBefore: true },
          ]}
          onSelect={(id) => check(applyFreeze(controller, id as FreezePreset))}
        />
        <ToolbarButton label="Find and replace" shortcut="Ctrl+F" icon={<Search size={16} />} onClick={onFind} />
      </ToolbarGroup>
    </Toolbar>
  );
}
