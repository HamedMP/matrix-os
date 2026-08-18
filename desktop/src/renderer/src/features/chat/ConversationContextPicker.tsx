import * as Popover from "@radix-ui/react-popover";
import type { KernelConversationContextProjection } from "@matrix-os/contracts";
import { Check, FolderOpen, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useBoard, type Project } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { useUi } from "../../stores/ui";

type ProjectListStatus = "idle" | "loading" | "ready" | "error";

export interface ConversationContextPickerProps {
  context: KernelConversationContextProjection | null;
  disabled?: boolean;
  onSelect: (projectId: string) => void;
  onRemove: () => void;
  triggerLabel?: string;
  triggerText?: string;
}

function projectKindLabel(project: Project): string {
  if (project.kind === "github") return "GitHub";
  if (project.kind === "folder") return "Folder";
  return "Scratch";
}

function projectRepositoryLabel(project: Project): string | null {
  return project.github ? `${project.github.owner}/${project.github.repo}` : null;
}

function optionLabel(project: Project): string {
  const repository = projectRepositoryLabel(project);
  return [project.name, projectKindLabel(project), repository].filter(Boolean).join(", ");
}

export default function ConversationContextPicker({
  context,
  disabled = false,
  onSelect,
  onRemove,
  triggerLabel,
  triggerText,
}: ConversationContextPickerProps) {
  const api = useConnection((state) => state.api);
  const projects = useBoard((state) => state.projects);
  const loadProjects = useBoard((state) => state.loadProjects);
  const openCreateProject = useUi((state) => state.openCreateProject);
  const [open, setOpen] = useState(false);
  const [listStatus, setListStatus] = useState<ProjectListStatus>("idle");
  const focusFirstOnOpen = useRef(false);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeProjects = projects.filter((project) => !project.archivedAt);

  useEffect(() => {
    if (!open) return;
    if (!api) {
      setListStatus("idle");
      return;
    }
    if (activeProjects.length > 0) {
      setListStatus("ready");
      return;
    }

    let current = true;
    setListStatus("loading");
    void (async () => {
      const loaded = await loadProjects(api);
      if (current) setListStatus(loaded ? "ready" : "error");
    })();
    return () => {
      current = false;
    };
  }, [activeProjects.length, api, loadProjects, open]);

  const retryProjects = async () => {
    if (!api) return;
    setListStatus("loading");
    const loaded = await loadProjects(api);
    setListStatus(loaded ? "ready" : "error");
  };

  const selectedLabel = context
    ? `Project ${context.projectName}${context.status === "unavailable" ? ", unavailable" : ""}`
    : "Add to project";
  const accessibleTriggerLabel = triggerLabel ?? selectedLabel;
  const visibleTriggerText = triggerText ?? (context?.projectName ?? "Add to project");

  const closeAndRestoreFocus = () => {
    setOpen(false);
  };

  const moveFocus = (index: number, direction: 1 | -1) => {
    if (activeProjects.length === 0) return;
    const next = (index + direction + activeProjects.length) % activeProjects.length;
    optionRefs.current[next]?.focus();
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!disabled) setOpen(nextOpen);
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={accessibleTriggerLabel}
          disabled={disabled}
          className="inline-flex h-7 max-w-56 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
          style={{ borderColor: "var(--border-default)", color: "var(--text-secondary)" }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" || disabled) return;
            event.preventDefault();
            focusFirstOnOpen.current = true;
            setOpen(true);
          }}
        >
          {context ? <FolderOpen size={13} aria-hidden /> : <Plus size={13} aria-hidden />}
          <span className="truncate">{visibleTriggerText}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          aria-label="Project context picker"
          className="z-50 w-72 rounded-xl border p-1.5 shadow-xl"
          style={{ borderColor: "var(--border-default)", background: "var(--bg-overlay)" }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (!focusFirstOnOpen.current) return;
            focusFirstOnOpen.current = false;
            queueMicrotask(() => optionRefs.current[0]?.focus());
          }}
        >
          <div
            role="listbox"
            aria-label="Choose project context"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeAndRestoreFocus();
              }
            }}
          >
            {!api ? (
              <p className="px-2 py-2 text-xs" style={{ color: "var(--text-tertiary)" }}>
                Project context is unavailable while disconnected.
              </p>
            ) : listStatus === "loading" ? (
              <p className="px-2 py-2 text-xs" style={{ color: "var(--text-tertiary)" }}>
                Loading projects…
              </p>
            ) : listStatus === "error" ? (
              <div className="px-2 py-2 text-xs" style={{ color: "var(--text-tertiary)" }}>
                <p>Projects unavailable.</p>
                <button
                  type="button"
                  className="mt-2 font-medium hover:underline"
                  style={{ color: "var(--accent)" }}
                  onClick={() => void retryProjects()}
                >
                  Retry projects
                </button>
              </div>
            ) : activeProjects.length === 0 ? (
              <div className="px-2 py-2 text-xs" style={{ color: "var(--text-tertiary)" }}>
                <p>No projects yet.</p>
                <button
                  type="button"
                  className="mt-2 font-medium hover:underline"
                  style={{ color: "var(--accent)" }}
                  onClick={() => {
                    closeAndRestoreFocus();
                    openCreateProject();
                  }}
                >
                  Create project
                </button>
              </div>
            ) : (
              activeProjects.map((project, index) => {
                const repository = projectRepositoryLabel(project);
                const selected = context?.projectId === project.slug;
                return (
                  <button
                    key={project.slug}
                    ref={(element) => {
                      optionRefs.current[index] = element;
                    }}
                    type="button"
                    role="option"
                    aria-label={optionLabel(project)}
                    aria-selected={selected}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)] focus-visible:outline-none"
                    onClick={() => {
                      onSelect(project.slug);
                      closeAndRestoreFocus();
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        moveFocus(index, 1);
                      } else if (event.key === "ArrowUp") {
                        event.preventDefault();
                        moveFocus(index, -1);
                      } else if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect(project.slug);
                        closeAndRestoreFocus();
                      }
                    }}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm" style={{ color: "var(--text-primary)" }}>
                        {project.name}
                      </span>
                      <span className="block truncate text-xs" style={{ color: "var(--text-tertiary)" }}>
                        {projectKindLabel(project)}{repository ? ` · ${repository}` : ""}
                      </span>
                    </span>
                    {selected ? <Check size={14} aria-hidden style={{ color: "var(--accent)" }} /> : null}
                  </button>
                );
              })
            )}
          </div>
          {context ? (
            <>
              <div className="my-1 h-px" style={{ background: "var(--border-subtle)" }} />
              <button
                type="button"
                aria-label="Remove project context"
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs hover:bg-[var(--bg-hover)]"
                style={{ color: "var(--text-secondary)" }}
                onClick={() => {
                  onRemove();
                  closeAndRestoreFocus();
                }}
              >
                <X size={13} aria-hidden />
                Remove project context
              </button>
            </>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
