import {
  isSafeCollaborationRelativePath,
  ProjectAgentContextSchema,
  ProjectMcpSourceSchema,
  ProjectSkillSourceSchema,
  type ProjectAgentContext,
} from "@matrix-os/contracts";
import { useEffect, useEffectEvent, useState } from "react";

export {
  parseProjectInstalledSkills,
  projectInstalledSkillFilePath,
  PROJECT_INSTALLED_SKILLS_PATH,
  PROJECT_INSTALLED_SKILLS_RESPONSE_LIMIT,
  PROJECT_SKILL_FILE_MAX_BYTES,
} from "./project-installed-skills.js";

export const PROJECT_AGENT_CONTEXT_INTRO =
  "Primary checkout · These files declare agent context. Loading and tool availability depend on the runtime.";
export const PROJECT_AGENT_CONTEXT_FILE_HANDOFF =
  "On Electron Desktop, open this project and choose Files to edit its declarations.";
export const PROJECT_AGENT_CONTEXT_MCP_HANDOFF =
  "On Electron Desktop, open Settings → MCPs to manage connected servers.";
export const PROJECT_AGENT_CONTEXT_MCP_SCOPE =
  "MCP settings manage connections for all projects on this computer.";
export const PROJECT_AGENT_CONTEXT_OPEN_FILE_ERROR = "The configuration file could not be opened. Refresh the list and try again.";
export const PROJECT_AGENT_CONTEXT_FILE_ERROR = "The project folder could not be opened. Try again.";
export const PROJECT_AGENT_CONTEXT_RESPONSE_LIMIT = 64 * 1024;

export type ProjectAgentContextRead = (path: string, signal: AbortSignal) => Promise<unknown>;
type ProjectAgentContextResult =
  | { kind: "ready"; context: ProjectAgentContext }
  | { kind: "unavailable" }
  | { kind: "error" };
type ProjectAgentContextState = ProjectAgentContextResult | { kind: "loading" };
type RequestIdentity = { scope: string; projectId: string; revision: number };

export function useProjectAgentContext({ scope, projectId, read }: {
  scope: string;
  projectId: string;
  read: ProjectAgentContextRead | null;
}): { state: ProjectAgentContextState; refresh(): void } {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<(RequestIdentity & { result: ProjectAgentContextResult }) | null>(null);

  const canRead = read !== null;
  const request = useEffectEvent(async (path: string, signal: AbortSignal) => read?.(path, signal) ?? null);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- an expanded project panel reads the current runtime's owner-scoped metadata; cleanup cancels obsolete reads.
  useEffect(() => {
    if (!canRead) return;
    const controller = new AbortController();
    const finish = (value: ProjectAgentContextResult) => {
      if (!controller.signal.aborted) setResult({ scope, projectId, revision, result: value });
    };
    void request(`/api/projects/${encodeURIComponent(projectId)}/agent-context`, controller.signal)
      .then((body) => {
        if (body === null) {
          finish({ kind: "unavailable" });
          return;
        }
        finish({ kind: "ready", context: ProjectAgentContextSchema.parse(body) });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.warn("[project-context] Context unavailable:", error instanceof Error ? error.name : "UnknownError");
        finish({ kind: "error" });
      });
    return () => controller.abort();
  }, [scope, projectId, canRead, revision]);

  const current = result?.scope === scope && result.projectId === projectId && result.revision === revision;
  return {
    state: read ? current ? result.result : { kind: "loading" } : { kind: "unavailable" },
    refresh: () => setRevision(value => value + 1),
  };
}

export function projectAgentContextStatus(state: ProjectAgentContextState): string | null {
  if (state.kind === "loading") return "Loading agent context…";
  if (state.kind === "unavailable") return "Agent context is unavailable for this project.";
  if (state.kind === "error") return "Agent context could not be loaded.";
  if (state.context.incompleteSources.length > 0) return "Some sources could not be read.";
  const { instructions, skills, mcpServers, configFiles } = state.context;
  return instructions.length + skills.length + mcpServers.length + (configFiles?.length ?? 0) === 0
    ? "No agent context files or declarations found in this project."
    : null;
}

type ConfigurationFile = { path: string; label: string; description?: string };

export type ProjectAgentConfigurationTemplate = { path: string; content: string };
export const PROJECT_AGENT_SKILL_NAME_ERROR = "Use up to 64 lowercase letters or numbers, separated by hyphens.";
export const PROJECT_AGENT_CONFIG_CREATE_ERROR = "The file could not be created. Check whether it already exists and try again.";

export type ProjectInstalledSkill = { name: string; file: string; description?: string };

export interface ProjectAgentConfigurationSection {
  id: "skills" | "mcp" | "config";
  title: string;
  description: string;
  emptyMessage: string;
  setupHint: string;
  browseLabel: string;
  rows: ConfigurationFile[];
  createFiles: ProjectAgentConfigurationTemplate[];
  partial: boolean;
}

export function projectAgentConfigurationSections(context: ProjectAgentContext): ProjectAgentConfigurationSection[] {
  const { instructions, skills, mcpServers, configFiles = [], incompleteSources } = context;
  const configPaths = [...new Set([...instructions, ...configFiles])];
  const mcpRows = ProjectMcpSourceSchema.options.flatMap(path => {
    const names = mcpServers.filter(server => server.source === path).map(server => server.name);
    if (!names.length && !configFiles.includes(path)) return [];
    const description = names.join(" · ") || (incompleteSources.includes(path)
      ? "Server declarations could not be read." : "No server declarations found.");
    return [{ path, label: path, description }];
  });
  const existingOrUnreadable = new Set<string>([...configPaths, ...mcpRows.map(row => row.path), ...incompleteSources]);
  const availableStarter = ({ path }: ProjectAgentConfigurationTemplate) => !existingOrUnreadable.has(path);

  return [
    {
      id: "skills",
      title: "Skills",
      description: "Manage the skill files stored in this project.",
      emptyMessage: "No project skills found.",
      setupHint: "To add one, create .agents/skills/<name>/SKILL.md in Files.",
      browseLabel: "Add skill in Files",
      rows: skills.map(({ name, source }) => ({ path: `${source}/${name}/SKILL.md`, label: name })),
      createFiles: [],
      partial: incompleteSources.some(source => ProjectSkillSourceSchema.safeParse(source).success),
    },
    {
      id: "mcp",
      title: "MCP",
      description: "Edit server declarations in this project. Tool availability depends on the agent runtime and its permissions.",
      emptyMessage: "No project MCP config files found.",
      setupHint: "To add a declaration, use .mcp.json or .codex/config.toml in Files.",
      browseLabel: "Open MCP config in Files",
      rows: mcpRows,
      createFiles: [
        { path: ".mcp.json", content: '{"mcpServers":{}}\n' },
        { path: ".codex/config.toml", content: "[mcp_servers]\n" },
      ].filter(availableStarter),
      partial: incompleteSources.some(source => ProjectMcpSourceSchema.safeParse(source).success),
    },
    {
      id: "config",
      title: "Config files",
      description: "Edit the project's instructions and runtime settings.",
      emptyMessage: "No recognized config files found.",
      setupHint: "To add instructions, create AGENTS.md or CLAUDE.md in Files.",
      browseLabel: "Open project files",
      rows: configPaths.map(path => ({ path, label: path })),
      createFiles: [
        { path: "AGENTS.md", content: "# Project instructions\n" },
        { path: "CLAUDE.md", content: "# Project instructions\n" },
        { path: ".claude/settings.json", content: "{}\n" },
      ].filter(availableStarter),
      partial: incompleteSources.some(source => !ProjectSkillSourceSchema.safeParse(source).success),
    },
  ];
}

/** The existing Files route returns a gateway-relative folder. */
export function projectAgentContextFilesPath(body: unknown): string | null {
  if (!body || typeof body !== "object" || !("path" in body)) return null;
  const path = body.path;
  return typeof path === "string" && isSafeCollaborationRelativePath(path) && !/[\u0000-\u001f\u007f]/.test(path)
    ? path
    : null;
}

/** Use the existing owner Files handoff, constrained to the project's immutable identity. */
export function projectAgentContextFileLocationRequest(slug: string, projectId: string, file?: string): string {
  const query = new URLSearchParams({ projectId });
  if (file !== undefined) query.set("file", file);
  return `/api/projects/${encodeURIComponent(slug)}/files-location?${query}`;
}
