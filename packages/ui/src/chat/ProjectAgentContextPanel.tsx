import { ChevronRight, FileCode, FolderOpen, Plug, SlidersHorizontal, Sparkles } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import { ProjectSkillActions, type NewSkillDraft, type ProjectSkillSourceActions } from "./ProjectSkillActions.js";
import {
  PROJECT_AGENT_CONFIG_CREATE_ERROR,
  PROJECT_AGENT_CONTEXT_FILE_HANDOFF,
  PROJECT_AGENT_CONTEXT_MCP_HANDOFF,
  PROJECT_AGENT_CONTEXT_MCP_SCOPE,
  projectAgentConfigurationSections,
  projectAgentContextStatus,
  useProjectAgentContext,
  type ProjectAgentConfigurationSection,
  type ProjectAgentConfigurationTemplate,
  type ProjectAgentContextRead,
} from "./project-agent-context.js";

interface ProjectAgentContextPanelProps extends ProjectSkillSourceActions {
  scope: string;
  projectId: string;
  read: ProjectAgentContextRead | null;
  onOpenFiles?: () => void;
  onOpenFile?: (relativePath: string) => void;
  onCreateFile?: (relativePath: string, content: string) => Promise<boolean>;
  filesPending?: boolean;
  filesError?: string | null;
  onOpenMcpSettings?: () => void;
}

type ConfigurationActions = Pick<ProjectAgentContextPanelProps, "onOpenFile" | "onOpenFiles" | "filesPending" | "onOpenMcpSettings">;

const disclosureClass = "flex min-h-10 w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium hover:bg-[var(--bg-hover,var(--accent))] focus-visible:outline-2 focus-visible:outline-[var(--accent)]";
const actionClass = "min-h-8 max-w-full rounded-md border px-2.5 py-1 text-left text-xs font-medium hover:bg-[var(--bg-hover,var(--accent))] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50";
const borderStyle = { borderColor: "var(--border-subtle, var(--border))" };
const secondaryStyle = { color: "var(--text-secondary, var(--muted-foreground))" };
const sectionIcons = { skills: Sparkles, mcp: Plug, config: FileCode };

export function ProjectAgentContextPanel(props: ProjectAgentContextPanelProps) {
  return <ProjectAgentContextDisclosure key={JSON.stringify([props.scope, props.projectId])} {...props} />;
}

function ProjectAgentContextDisclosure(props: ProjectAgentContextPanelProps) {
  const id = useId();
  const [open, setOpen] = useState(false);

  return (
    <div className="my-3 min-w-0 rounded-xl border" style={borderStyle}>
      <button id={`${id}-trigger`} type="button" aria-expanded={open} aria-controls={id}
        className={`${disclosureClass} rounded-xl`}
        onClick={() => setOpen(value => !value)}>
        <span className="flex min-w-0 items-center gap-2">
          <SlidersHorizontal size={16} aria-hidden className="shrink-0" />
          <span>Agent configuration</span>
        </span>
        <ChevronRight size={16} aria-hidden className={open ? "shrink-0 rotate-90" : "shrink-0"} />
      </button>
      <div id={id} role="region" aria-labelledby={`${id}-trigger`} hidden={!open}>
        {open ? <ProjectAgentContextDetails {...props} /> : null}
      </div>
    </div>
  );
}

function ProjectAgentContextDetails({ scope, projectId, read, filesError, onCreateFile, loadInstalledSkills,
  readInstalledSkill, ...actions }: ProjectAgentContextPanelProps) {
  const { state, refresh } = useProjectAgentContext({ scope, projectId, read });
  const status = projectAgentContextStatus(state);
  const [openSection, setOpenSection] = useState<ProjectAgentConfigurationSection["id"] | null>("skills");
  // Inventory refreshes can unmount the sections. Keep the draft within the current project and runtime.
  const [newSkillDraft, setNewSkillDraft] = useState<NewSkillDraft | null>(null);
  const creating = useRef(false);
  const [creationPending, setCreationPending] = useState(false);
  const [createdPath, setCreatedPath] = useState<string | null>(null);
  const canCreate = onCreateFile && state.kind === "ready" && state.context.configFiles !== undefined;
  const filesPending = Boolean(actions.filesPending || creationPending);

  const create = async ({ path, content }: ProjectAgentConfigurationTemplate, onCreated?: () => void) => {
    if (!onCreateFile || creating.current || actions.filesPending) return false;
    creating.current = true;
    setCreatedPath(null);
    setCreationPending(true);
    try {
      if (!await onCreateFile(path, content)) return false;
      onCreated?.();
      setCreatedPath(path);
      refresh();
      return true;
    } catch (error: unknown) {
      console.warn("[project-context] Could not create config file:", error instanceof Error ? error.name : "UnknownError");
      return false;
    } finally {
      creating.current = false;
      setCreationPending(false);
    }
  };

  return (
    <div className="min-w-0 space-y-3 border-t p-3" style={borderStyle}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">Primary checkout</p>
          <p className="mt-0.5 text-xs leading-relaxed" style={secondaryStyle}>
            Manage the skills, MCP declarations and settings stored in this project.
          </p>
        </div>
        {read && state.kind !== "loading" ? <button type="button" className={actionClass} style={borderStyle} disabled={creationPending}
          onClick={refresh}>{state.kind === "error" ? "Try again" : "Refresh"}</button> : null}
      </div>
      {status ? <p role={state.kind === "error" ? "alert" : "status"} className="text-xs" style={secondaryStyle}>
        {status}{state.kind === "ready" && state.context.incompleteSources.length > 0
          ? <> {state.context.incompleteSources.join(", ")}.</>
          : null}
      </p> : null}
      {createdPath ? <p role="status" className="break-all text-xs" style={secondaryStyle}>Created {createdPath}.</p> : null}
      {state.kind === "ready" ? <>
        <div className="space-y-2">
          {projectAgentConfigurationSections(state.context).map(section => (
            <ProjectConfigurationSection key={section.id} section={section} {...actions}
              open={openSection === section.id}
              onToggle={() => setOpenSection(current => current === section.id ? null : section.id)}
              onCreate={canCreate ? create : undefined}
              skillActions={canCreate && section.id === "skills" ? <ProjectSkillActions filesPending={filesPending}
                onCreate={template => create(template, () => setNewSkillDraft(null))}
                loadInstalledSkills={loadInstalledSkills} readInstalledSkill={readInstalledSkill}
                newSkillDraft={newSkillDraft} onNewSkillDraftChange={setNewSkillDraft} /> : null}
              filesPending={filesPending} />
          ))}
        </div>
        {!actions.onOpenFiles && !actions.onOpenFile ? <p className="text-xs" style={secondaryStyle}>{PROJECT_AGENT_CONTEXT_FILE_HANDOFF}</p> : null}
      </> : null}
      {filesError ? <p role="alert" className="text-xs">{filesError}</p> : null}
    </div>
  );
}

type CreateTemplate = (template: ProjectAgentConfigurationTemplate) => Promise<boolean>;

type ConfigurationSectionProps = ConfigurationActions & {
  section: ProjectAgentConfigurationSection;
  onCreate?: CreateTemplate;
  skillActions?: ReactNode;
};

function ProjectConfigurationSection({ open, onToggle, ...props }: ConfigurationSectionProps & {
  open: boolean;
  onToggle: () => void;
}) {
  const panelId = useId();
  const triggerId = `${panelId}-trigger`;
  const { id, title } = props.section;
  const Icon = sectionIcons[id];

  return (
    <section className="min-w-0 rounded-lg border" style={borderStyle}>
      <h3>
        <button id={triggerId} type="button" aria-expanded={open} aria-controls={panelId}
          className={`${disclosureClass} rounded-lg`} onClick={onToggle}>
          <span className="flex min-w-0 items-center gap-2">
            <Icon size={15} aria-hidden className="shrink-0" />{title}
          </span>
          <ChevronRight size={16} aria-hidden className={open ? "shrink-0 rotate-90" : "shrink-0"} />
        </button>
      </h3>
      <div id={panelId} role="region" aria-labelledby={triggerId} hidden={!open} className="border-t" style={borderStyle}>
        <ProjectConfigurationSectionContent {...props} />
      </div>
    </section>
  );
}

function ProjectConfigurationSectionContent({ section, onOpenFile, onOpenFiles, filesPending, onOpenMcpSettings, onCreate,
  skillActions }: ConfigurationSectionProps) {
  const { id, title, description, rows, partial, emptyMessage, setupHint, browseLabel, createFiles } = section;
  const [createError, setCreateError] = useState<string | null>(null);
  const showBrowse = onOpenFiles && (id === "config" || !onCreate || partial);

  const create = async (template: ProjectAgentConfigurationTemplate) => {
    setCreateError(null);
    if (!await onCreate?.(template)) setCreateError(PROJECT_AGENT_CONFIG_CREATE_ERROR);
  };

  return (
    <>
      <div className="space-y-2 px-3 py-2.5">
        <p className="text-xs leading-relaxed" style={secondaryStyle}>{description}</p>
        {skillActions}
        {onCreate && createFiles.length > 0 ? <div className="flex flex-wrap gap-2">
          {createFiles.map(template => <button key={template.path} type="button" className={actionClass}
            style={borderStyle} disabled={filesPending} onClick={() => { void create(template); }}>
            Create {template.path}
          </button>)}
        </div> : null}
        {showBrowse ? <button type="button" className={actionClass} style={borderStyle} disabled={filesPending}
          onClick={onOpenFiles}>
          <span className="flex items-center gap-1.5"><FolderOpen size={13} aria-hidden className="shrink-0" />{browseLabel}</span>
        </button> : null}
        {partial ? <p className="text-xs" style={secondaryStyle}>Some {title} sources could not be read.</p> : null}
        {!partial && rows.length === 0 ? <p className="text-xs leading-relaxed" style={secondaryStyle}>
          {emptyMessage}{onCreate ? null : ` ${setupHint}`}
        </p> : null}
        {id === "config" && onCreate && onOpenFile && !partial && createFiles.length === 0 ? (
          <p className="text-xs leading-relaxed" style={secondaryStyle}>The starter config files already exist. Open a file to edit it.</p>
        ) : null}
        {createError ? <p role="alert" className="text-xs">{createError}</p> : null}
      </div>
      {rows.length > 0 ? <ul className="max-h-56 overflow-y-auto">
        {rows.map(({ path, label, description: detail }) => (
          <li key={path} className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t px-3 py-2" style={borderStyle}>
            <div className="min-w-0 flex-1 basis-28">
              <p className={`[overflow-wrap:anywhere] text-xs font-medium${label === path ? " font-mono" : ""}`}>{label}</p>
              {label !== path ? <p className="mt-0.5 [overflow-wrap:anywhere] font-mono text-[11px]" style={secondaryStyle}>{path}</p> : null}
              {detail ? <p className="mt-0.5 [overflow-wrap:anywhere] text-xs" style={secondaryStyle}>{detail}</p> : null}
            </div>
            {onOpenFile ? <button type="button" aria-label={`Open ${path}`} className={actionClass} style={borderStyle}
              disabled={filesPending} onClick={() => onOpenFile(path)}>Open file</button> : null}
          </li>
        ))}
      </ul> : null}
      {id === "mcp" ? <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2.5" style={borderStyle}>
        <p className="text-xs leading-relaxed" style={secondaryStyle}>
          {onOpenMcpSettings ? PROJECT_AGENT_CONTEXT_MCP_SCOPE : PROJECT_AGENT_CONTEXT_MCP_HANDOFF}
        </p>
        {onOpenMcpSettings ? <button type="button" className={actionClass} style={borderStyle} onClick={onOpenMcpSettings}>
          Open MCP settings
        </button> : null}
      </div> : null}
    </>
  );
}
