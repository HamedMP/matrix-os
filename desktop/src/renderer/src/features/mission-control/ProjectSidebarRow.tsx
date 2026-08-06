import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Archive, MoreHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Project } from "../../stores/board";
import ProjectLifecycleDialog from "./ProjectLifecycleDialog";

export default function ProjectSidebarRow({
  project,
  active,
  attention,
  onOpen,
}: {
  project: Project;
  active: boolean;
  attention: number;
  onOpen: () => void;
}) {
  const [dialogMode, setDialogMode] = useState<"archive" | "delete" | null>(null);

  return (
    <>
      <div
        className="group/project-row flex w-full items-center rounded-md transition-colors duration-100"
        style={{ background: active ? "var(--bg-selected)" : "transparent" }}
      >
        <button
          type="button"
          aria-label={`Open ${project.name}`}
          className="flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pl-2.5 text-sm font-medium"
          style={{ color: active ? "var(--text-primary)" : "var(--text-secondary)" }}
          onClick={onOpen}
        >
          <span className="text-xs" style={{ color: active ? "var(--accent)" : "var(--text-tertiary)" }}>▣</span>
          <span className="min-w-0 flex-1 truncate text-left">{project.name || project.slug}</span>
          {attention > 0 ? (
            <span className="rounded-full px-1.5 text-xs" style={{ background: "var(--highlight-muted)", color: "var(--highlight)" }}>
              {attention}
            </span>
          ) : null}
        </button>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label={`Project actions for ${project.name}`}
              className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded opacity-0 outline-none transition-opacity hover:bg-[var(--bg-hover)] focus:opacity-100 group-hover/project-row:opacity-100 data-[state=open]:opacity-100"
              style={{ color: "var(--text-tertiary)" }}
            >
              <MoreHorizontal size={14} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="right"
              align="start"
              sideOffset={6}
              className="fade-in z-[100] min-w-[190px] rounded-lg border p-1"
              style={{ background: "var(--bg-overlay)", borderColor: "var(--border-default)", boxShadow: "var(--shadow-2)" }}
            >
              <DropdownMenu.Item
                className="flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-[var(--bg-hover)]"
                style={{ color: "var(--text-primary)" }}
                onSelect={() => setDialogMode("archive")}
              >
                <Archive size={14} /> Archive project
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px" style={{ background: "var(--border-subtle)" }} />
              <DropdownMenu.Item
                className="flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-[var(--danger-muted)]"
                style={{ color: "var(--danger)" }}
                onSelect={() => setDialogMode("delete")}
              >
                <Trash2 size={14} /> Delete project
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      {dialogMode ? (
        <ProjectLifecycleDialog
          open
          mode={dialogMode}
          project={project}
          onClose={() => setDialogMode(null)}
        />
      ) : null}
    </>
  );
}
