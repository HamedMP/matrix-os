import type { OsViewFixedAppIcon } from "@matrix-os/contracts";
import {
  Blocks,
  Brain,
  BrushIcon,
  Code2,
  FilePenLine,
  FolderTree,
  Globe2,
  LayoutGrid,
  MessageSquare,
  Monitor,
  Notebook,
  Settings,
  SquareTerminal,
  type LucideIcon,
} from "@/lib/hugeicons";

/** The Web glyph for each icon name in the shared fixed app table (`OS_VIEW_FIXED_APP_APPEARANCES`). */
export const OS_VIEW_FIXED_APP_ICON_COMPONENTS: Readonly<Record<OsViewFixedAppIcon, LucideIcon>> = {
  "message-square": MessageSquare,
  "square-terminal": SquareTerminal,
  "folder-tree": FolderTree,
  "file-pen": FilePenLine,
  code: Code2,
  settings: Settings,
  blocks: Blocks,
  globe: Globe2,
  notebook: Notebook,
  brush: BrushIcon,
  brain: Brain,
  "layout-grid": LayoutGrid,
  monitor: Monitor,
};
