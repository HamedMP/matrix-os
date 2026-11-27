import type { CSSProperties, ReactNode } from "react";
import type { DropdownItem } from "./Dropdown";

/** Menu entries for split and menu buttons (same shape as Dropdown items). */
export type RibbonMenuItem = DropdownItem;

interface RibbonItemBase {
  id: string;
  /** Accessible name and tooltip text. */
  label: string;
  /** Shortcut shown in the tooltip and announced through aria-keyshortcuts, e.g. "Ctrl+B". */
  shortcut?: string;
  disabled?: boolean;
}

interface RibbonButtonLook {
  icon?: ReactNode;
  /** "large" puts the icon above the label; "small" (default) is an inline row button. */
  size?: "large" | "small";
  /** Small buttons only: render the label next to the icon (default true; icon-only when false). */
  showLabel?: boolean;
}

export interface RibbonButtonItem extends RibbonItemBase, RibbonButtonLook {
  kind: "button";
  onClick: () => void;
}

export interface RibbonToggleItem extends RibbonItemBase, RibbonButtonLook {
  kind: "toggle";
  pressed: boolean;
  onToggle: (next: boolean) => void;
}

export interface RibbonSplitItem extends RibbonItemBase, RibbonButtonLook {
  kind: "split";
  /** The primary half runs this. */
  onClick: () => void;
  menu: readonly RibbonMenuItem[];
  onMenuSelect: (id: string) => void;
  /** Name of the arrow half (default "{label} options"). */
  menuLabel?: string;
}

/** A button that only opens a menu. */
export interface RibbonMenuButtonItem extends RibbonItemBase, RibbonButtonLook {
  kind: "menu";
  menu: readonly RibbonMenuItem[];
  onMenuSelect: (id: string) => void;
}

export interface RibbonSelectOption {
  value: string;
  label: string;
  /** Optional preview style, e.g. { fontFamily } for a font list. */
  style?: CSSProperties;
}

/** Dropdown list: font family, size, paragraph style, number format. */
export interface RibbonSelectItem extends RibbonItemBase {
  kind: "select";
  value: string;
  options: readonly RibbonSelectOption[];
  onChange: (value: string) => void;
  /** Width in px (default 120). */
  width?: number;
  /** Allow typing a value that is not in the list (font size). Commits on Enter or blur; Escape reverts. */
  editable?: boolean;
  placeholder?: string;
}

export interface RibbonColorSwatch {
  value: string;
  name: string;
}

/** Split colour button: the face applies the current colour, the arrow opens a palette with recent colours. */
export interface RibbonColorItem extends RibbonItemBase {
  kind: "color";
  icon?: ReactNode;
  /** Current colour (CSS colour string) or null for automatic/none. */
  value: string | null;
  onChange: (color: string | null) => void;
  palette?: readonly RibbonColorSwatch[];
  /** Offer an "Automatic" (null) choice, labelled by noneLabel. */
  allowNone?: boolean;
  noneLabel?: string;
}

export interface RibbonGalleryOption {
  id: string;
  label: string;
  /** Swatch content; defaults to the label rendered with `style`. */
  preview?: ReactNode;
  style?: CSSProperties;
}

/** Row of style swatches with a "More" popover listing every option. */
export interface RibbonGalleryItem extends RibbonItemBase {
  kind: "gallery";
  options: readonly RibbonGalleryOption[];
  value?: string;
  onSelect: (id: string) => void;
  /** Swatches shown inline (default 4). */
  visible?: number;
}

export interface RibbonSeparatorItem {
  kind: "separator";
  id: string;
}

/** Lays small items out in stacked rows, e.g. [[font, size], [bold, italic, underline]]. */
export interface RibbonStackItem {
  kind: "stack";
  id: string;
  rows: ReadonlyArray<readonly RibbonItem[]>;
}

export type RibbonItem =
  | RibbonButtonItem
  | RibbonToggleItem
  | RibbonSplitItem
  | RibbonMenuButtonItem
  | RibbonSelectItem
  | RibbonColorItem
  | RibbonGalleryItem
  | RibbonSeparatorItem
  | RibbonStackItem;

export interface RibbonGroup {
  id: string;
  label: string;
  /** Icon for the overflow button shown when the group collapses at narrow widths. */
  icon?: ReactNode;
  items: readonly RibbonItem[];
  /** Small corner button that opens the group's full dialog. */
  launcher?: { label: string; onClick: () => void; shortcut?: string };
}

export interface BackstageApi {
  close: () => void;
  /** Show another item's content. */
  select: (id: string) => void;
}

export interface BackstageItem {
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  separatorBefore?: boolean;
  /** Content shown on the right when the item is chosen (New, Open, Export). */
  render?: (api: BackstageApi) => ReactNode;
  /** Immediate action (Save, Download, Close). The backstage closes first unless keepOpen is set. */
  onSelect?: (api: BackstageApi) => void;
  keepOpen?: boolean;
}

export interface RibbonBackstage {
  items: readonly BackstageItem[];
  /** Item shown first (default: the first item with content). */
  defaultItem?: string;
  /** Back button name (default "Back to document"). */
  backLabel?: string;
}

export interface RibbonPanelTab {
  id: string;
  label: string;
  mode?: "panel";
  groups: readonly RibbonGroup[];
}

export interface RibbonBackstageTab {
  id: string;
  label: string;
  mode: "backstage";
  backstage: RibbonBackstage;
}

export type RibbonTab = RibbonPanelTab | RibbonBackstageTab;
