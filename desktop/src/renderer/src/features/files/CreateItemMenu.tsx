import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { File, FolderPlus, Plus } from "@renderer/lib/hugeicons";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import { IconButton } from "../../design/primitives";

const itemClass = "flex cursor-default items-center gap-2 rounded-md px-3 py-2 text-sm text-[var(--text-primary)] outline-none data-[highlighted]:bg-[var(--bg-hover)]";

export function CreateItemMenu({ onCreateFolder, onCreateFile }: {
  onCreateFolder?: () => void;
  onCreateFile?: () => void;
}) {
  if (!onCreateFolder && !onCreateFile) return null;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <IconButton
          label="Create"
          className="h-8 w-8 shrink-0 border"
          style={{ borderColor: "var(--border-subtle)", background: "var(--bg-raised)" }}
        >
          <Plus size={16} aria-hidden />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="min-w-36 rounded-lg border p-1 outline-none"
          style={{ zIndex: DESKTOP_Z_INDEX.popover, background: "var(--bg-overlay)", borderColor: "var(--border-default)", boxShadow: "var(--shadow-2)" }}
        >
          {onCreateFolder ? (
            <DropdownMenu.Item onSelect={onCreateFolder} className={itemClass}>
              <FolderPlus size={14} aria-hidden /> New Folder
            </DropdownMenu.Item>
          ) : null}
          {onCreateFile ? (
            <DropdownMenu.Item onSelect={onCreateFile} className={itemClass}>
              <File size={14} aria-hidden /> New File
            </DropdownMenu.Item>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
