import { Check, FolderGitIcon, FolderOpen, Plus, X } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as Popover from "@radix-ui/react-popover";
import type { KernelConversationContextProjection } from "@matrix-os/contracts";
import { useRef, useState } from "react";

export type ChatProjectListStatus = "idle" | "loading" | "ready" | "error" | "disconnected";

export interface ChatProjectOption {
  id?: string;
  slug: string;
  name: string;
  kind?: "scratch" | "github" | "folder";
  /** `owner/repo` for a GitHub-backed project. */
  repository?: string | null;
}

function projectKindLabel(project: ChatProjectOption): string {
  if (project.kind === "github") return "GitHub";
  if (project.kind === "folder") return "Folder";
  return "Scratch";
}

function optionLabel(project: ChatProjectOption): string {
  return [project.name, projectKindLabel(project), project.repository].filter(Boolean).join(", ");
}

const TRIGGER_CLASS = {
  compact: "inline-flex h-7 w-8 shrink-0 items-center justify-center rounded-[8px] border hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--composer-focus,var(--accent))] disabled:cursor-not-allowed disabled:opacity-50",
  labelled: "inline-flex h-7 min-w-0 max-w-[min(18rem,45vw)] items-center gap-1.5 rounded-md px-1.5 text-xs font-medium hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--composer-focus,var(--accent))] disabled:cursor-not-allowed disabled:opacity-50",
};

/** Label, icon and shape of the trigger: an icon-only folder when compact, as on Electron Desktop. */
function triggerPresentation({ context, kind, compact, triggerLabel, triggerText }: {
  context: KernelConversationContextProjection | null;
  kind: "project" | "repository";
  compact: boolean;
  triggerLabel?: string;
  triggerText?: string;
}) {
  const labels = triggerLabels(context, kind);
  const text = triggerText ?? labels.visible;
  return {
    label: triggerLabel ?? labels.accessible,
    title: compact ? text : undefined,
    text: compact ? null : text,
    className: compact ? TRIGGER_CLASS.compact : TRIGGER_CLASS.labelled,
    icon: compact ? FolderOpen : kind === "repository" ? FolderGitIcon : context ? FolderOpen : Plus,
    iconSize: compact ? 15 : 13,
  };
}

function listHasChoices(listStatus: ChatProjectListStatus, projects: readonly ChatProjectOption[]): boolean {
  return (listStatus === "ready" || listStatus === "idle") && projects.length > 0;
}

function RemoveProjectContext({ onRemove }: { onRemove: () => void }) {
  return (
    <>
      <div className="my-1 h-px" style={{ background: "var(--border-subtle)" }} />
      <button
        type="button"
        aria-label="Remove project context"
        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs hover:bg-[var(--bg-hover)]"
        style={{ color: "var(--text-secondary)" }}
        onClick={onRemove}
      >
        <HugeiconsIcon icon={X} size={13} strokeWidth={1.5} aria-hidden />
        Remove project context
      </button>
    </>
  );
}

function triggerLabels(context: KernelConversationContextProjection | null, kind: "project" | "repository") {
  const unavailableSuffix = context?.status === "unavailable" ? ", unavailable" : "";
  if (kind === "repository") {
    return {
      accessible: context?.repositoryLabel
        ? `Repository ${context.repositoryLabel}${unavailableSuffix}`
        : context ? `Repository unavailable for ${context.projectName}` : "Choose repository",
      visible: context?.repositoryLabel ?? (context ? "No repository" : "Choose repository"),
    };
  }
  return {
    accessible: context ? `Project ${context.projectName}${unavailableSuffix}` : "Add to project",
    visible: context?.projectName ?? "Add to project",
  };
}

/** The project rows, with Electron's arrow-key focus loop. */
function ProjectOptions({ projects, context, optionRefs, onChoose }: {
  projects: readonly ChatProjectOption[];
  context: KernelConversationContextProjection | null;
  optionRefs: { current: Array<HTMLButtonElement | null> };
  onChoose: (slug: string) => void;
}) {
  const moveFocus = (index: number, direction: 1 | -1) => {
    const next = (index + direction + projects.length) % projects.length;
    optionRefs.current[next]?.focus();
  };
  return projects.map((project, index) => {
    const selected = context?.projectId === project.slug || (project.id !== undefined && context?.projectId === project.id);
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
        onClick={() => onChoose(project.slug)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            moveFocus(index, 1);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            moveFocus(index, -1);
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onChoose(project.slug);
          }
        }}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm" style={{ color: "var(--text-primary)" }}>
            {project.name}
          </span>
          <span className="block truncate text-xs" style={{ color: "var(--text-tertiary)" }}>
            {projectKindLabel(project)}{project.repository ? ` · ${project.repository}` : ""}
          </span>
        </span>
        {selected ? <HugeiconsIcon icon={Check} size={14} strokeWidth={1.5} aria-hidden style={{ color: "var(--composer-focus, var(--accent))" }} /> : null}
      </button>
    );
  });
}

/** The picker body when there is no project list to choose from. */
function ProjectListNotice({ listStatus, onRetry, onCreateProject }: {
  listStatus: ChatProjectListStatus;
  onRetry?: () => void;
  onCreateProject?: () => void;
}) {
  const action = (label: string, onClick: () => void) => (
    <button
      type="button"
      className="mt-2 font-medium hover:underline"
      style={{ color: "var(--composer-focus, var(--accent))" }}
      onClick={onClick}
    >
      {label}
    </button>
  );
  if (listStatus === "disconnected") {
    return <p className="px-2 py-2 text-xs" style={{ color: "var(--text-tertiary)" }}>Project context is unavailable while disconnected.</p>;
  }
  if (listStatus === "loading") {
    return <p className="px-2 py-2 text-xs" style={{ color: "var(--text-tertiary)" }}>Loading projects…</p>;
  }
  if (listStatus === "error") {
    return (
      <div className="px-2 py-2 text-xs" style={{ color: "var(--text-tertiary)" }}>
        <p>Projects unavailable.</p>
        {onRetry ? action("Retry projects", onRetry) : null}
      </div>
    );
  }
  return (
    <div className="px-2 py-2 text-xs" style={{ color: "var(--text-tertiary)" }}>
      <p>No projects yet.</p>
      {onCreateProject ? action("Create project", onCreateProject) : null}
    </div>
  );
}

/**
 * The composer's project (or repository) context picker shared by Web and
 * Electron Desktop Chat. Hosts own the project list and load it when
 * `onOpenChange(true)` fires.
 */
export function ChatProjectContextPicker({
  context,
  projects,
  listStatus,
  disabled = false,
  kind = "project",
  triggerLabel,
  triggerText,
  compact = false,
  menuZIndex,
  onOpenChange,
  onRetry,
  onCreateProject,
  onSelect,
  onRemove,
}: {
  context: KernelConversationContextProjection | null;
  projects: readonly ChatProjectOption[];
  listStatus: ChatProjectListStatus;
  disabled?: boolean;
  kind?: "project" | "repository";
  triggerLabel?: string;
  triggerText?: string;
  compact?: boolean;
  menuZIndex?: number;
  onOpenChange?: (open: boolean) => void;
  onRetry?: () => void;
  /** Omit when the host cannot create projects; the empty list then only explains. */
  onCreateProject?: () => void;
  onSelect: (projectSlug: string) => void;
  onRemove: () => void;
}) {
  const [open, setOpenState] = useState(false);
  const focusFirstOnOpen = useRef(false);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };

  const trigger = triggerPresentation({ context, kind, compact, triggerLabel, triggerText });

  const choose = (slug: string) => {
    onSelect(slug);
    setOpen(false);
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
          aria-label={trigger.label}
          title={trigger.title}
          disabled={disabled}
          className={trigger.className}
          style={{ color: "var(--text-secondary)", borderColor: "var(--border-subtle)" }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" || disabled) return;
            event.preventDefault();
            focusFirstOnOpen.current = true;
            setOpen(true);
          }}
        >
          <HugeiconsIcon icon={trigger.icon} size={trigger.iconSize} strokeWidth={1.5} aria-hidden style={{ color: "var(--text-tertiary)" }} />
          {trigger.text ? <span className="truncate">{trigger.text}</span> : null}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          aria-label="Project context picker"
          className="matrix-chat-composer-menu z-50 w-72 rounded-xl border p-1.5 shadow-xl"
          style={{ borderColor: "var(--border-default)", background: "var(--bg-overlay)", ...(menuZIndex === undefined ? {} : { zIndex: menuZIndex }) }}
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
                setOpen(false);
              }
            }}
          >
            {listHasChoices(listStatus, projects) ? (
              <ProjectOptions projects={projects} context={context} optionRefs={optionRefs} onChoose={choose} />
            ) : (
              <ProjectListNotice listStatus={listStatus} onRetry={onRetry} onCreateProject={onCreateProject ? () => {
                setOpen(false);
                onCreateProject();
              } : undefined} />
            )}
          </div>
          {context ? <RemoveProjectContext onRemove={() => {
            onRemove();
            setOpen(false);
          }} /> : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
