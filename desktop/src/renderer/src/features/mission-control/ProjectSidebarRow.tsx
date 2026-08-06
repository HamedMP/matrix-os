import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Archive, MoreHorizontal, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Dialog } from "../../design/primitives";
import type { Project } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { useProjectLifecycle } from "../../stores/project-lifecycle";
import { useUi } from "../../stores/ui";
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
  const api = useConnection((state) => state.api);
  const pendingProjectSlug = useProjectLifecycle((state) => state.pendingProjectSlug);
  const archiveProject = useProjectLifecycle((state) => state.archiveProject);
  const acquireRendererOverlay = useUi((state) => state.acquireRendererOverlay);
  const releaseRendererOverlay = useUi((state) => state.releaseRendererOverlay);
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const pending = pendingProjectSlug === project.slug;
  const rendererOverlayOpen = menuOpen || deleteOpen || pending || archiveError !== null;

  useEffect(() => {
    if (!rendererOverlayOpen) return;
    acquireRendererOverlay();
    return releaseRendererOverlay;
  }, [acquireRendererOverlay, releaseRendererOverlay, rendererOverlayOpen]);

  const archive = async () => {
    if (!api || pending) return;
    setArchiveError(null);
    const succeeded = await archiveProject(api, project.slug);
    if (!succeeded) {
      const message = useProjectLifecycle.getState().error;
      setArchiveError(message ?? "The project could not be archived. Try again.");
    }
  };

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

        <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
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
                disabled={!api || pending}
                onSelect={() => void archive()}
              >
                <Archive size={14} /> Archive project
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px" style={{ background: "var(--border-subtle)" }} />
              <DropdownMenu.Item
                className="flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-[var(--danger-muted)]"
                style={{ color: "var(--danger)" }}
                disabled={pending}
                onSelect={() => setDeleteOpen(true)}
              >
                <Trash2 size={14} /> Delete project
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      {deleteOpen ? (
        <ProjectLifecycleDialog
          open
          project={project}
          onClose={() => setDeleteOpen(false)}
        />
      ) : null}
      {archiveError ? (
        <Dialog open onClose={() => setArchiveError(null)} width={400}>
          <div className="border-b px-5 py-4" style={{ borderColor: "var(--border-subtle)" }}>
            <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
              Project couldn't be archived
            </h2>
            <p role="alert" className="mt-2 text-sm" style={{ color: "var(--danger)" }}>
              {archiveError}
            </p>
          </div>
          <div className="flex justify-end px-5 py-3">
            <Button variant="primary" onClick={() => setArchiveError(null)}>Close</Button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
