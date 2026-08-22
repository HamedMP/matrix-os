import { basename } from "node:path";
import { defineCommand } from "citty";
import { resolveCliProfile } from "../profiles.js";
import { formatCliError, formatCliErrorMessage, formatCliSuccess } from "../output.js";
import { createShellClient, type ShellClient, type TerminalRef } from "../shell-client.js";
import { requireCliAuthToken } from "../auth-state.js";

const TERMINAL_WORKSPACE_ID = /^tws_[0-9a-f]{32}$/;
const TERMINAL_TAB_ID = /^tt_[0-9a-f]{32}$/;
const PROJECT_ID = /^proj_[0-9a-f]{16,64}$/;
const SHELL_USAGE = "Usage: matrix shell list|new|connect|rm [--project <project>] [--tab <tab>]";

const commonArgs = {
  profile: { type: "string", required: false },
  dev: { type: "boolean", required: false, default: false },
  gateway: { type: "string", required: false },
  token: { type: "string", required: false },
  json: { type: "boolean", required: false, default: false },
} as const;

type ProjectRecord = { id: string; label: string };
type TabRecord = { id: string; name: string; cwd?: string; status?: string };
type WorkspaceRecord = {
  id: string;
  scope: "main" | "project";
  projectId?: string;
  tabs: TabRecord[];
};

async function clientFromArgs(args: Record<string, unknown>): Promise<ShellClient> {
  const profile = await resolveCliProfile(args);
  const token = await requireCliAuthToken(profile);
  return createShellClient({ gatewayUrl: profile.gatewayUrl, token });
}

function codedError(message: string, code = "invalid_request"): Error {
  return Object.assign(new Error(message), { code });
}

function writeError(err: unknown, json: boolean): void {
  const code = err instanceof Error && "code" in err && typeof (err as { code?: unknown }).code === "string"
    ? (err as { code: string }).code
    : "request_failed";
  const safeMessage = code === "invalid_request" || code === "not_authenticated" ? (err instanceof Error ? err.message : undefined) : undefined;
  console.error(json ? formatCliError(code, safeMessage) : safeMessage ?? formatCliErrorMessage(code));
}

function parseProjects(value: unknown[]): ProjectRecord[] {
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    return typeof record.id === "string" && typeof record.label === "string" ? [{ id: record.id, label: record.label }] : [];
  });
}

function parseWorkspaces(value: unknown[]): WorkspaceRecord[] {
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (!TERMINAL_WORKSPACE_ID.test(String(record.id)) || (record.scope !== "main" && record.scope !== "project") || !Array.isArray(record.tabs)) return [];
    const tabs = record.tabs.flatMap((tab) => {
      if (!tab || typeof tab !== "object") return [];
      const candidate = tab as Record<string, unknown>;
      if (!TERMINAL_TAB_ID.test(String(candidate.id)) || typeof candidate.name !== "string") return [];
      return [{
        id: String(candidate.id),
        name: candidate.name,
        ...(typeof candidate.cwd === "string" ? { cwd: candidate.cwd } : {}),
        ...(typeof candidate.status === "string" ? { status: candidate.status } : {}),
      }];
    });
    return [{
      id: String(record.id),
      scope: record.scope,
      ...(typeof record.projectId === "string" ? { projectId: record.projectId } : {}),
      tabs,
    }];
  });
}

function projectForInput(projects: ProjectRecord[], requested: unknown): ProjectRecord | null | undefined {
  if (requested === "main") return null;
  if (typeof requested === "string") {
    return projects.find((project) => project.id === requested || project.label === requested);
  }
  const localProject = basename(process.cwd());
  return projects.find((project) => project.label === localProject);
}

async function resolveWorkspace(client: ShellClient, requestedProject: unknown): Promise<{ workspace: WorkspaceRecord; project: ProjectRecord | null }> {
  const [rawProjects, rawWorkspaces] = await Promise.all([client.listProjects(), client.listWorkspaces()]);
  const projects = parseProjects(rawProjects);
  const workspaces = parseWorkspaces(rawWorkspaces);
  const project = projectForInput(projects, requestedProject);
  if (typeof requestedProject === "string" && requestedProject !== "main" && !project) {
    throw codedError("Project not found");
  }
  const existing = project
    ? workspaces.find((workspace) => workspace.scope === "project" && workspace.projectId === project.id)
    : workspaces.find((workspace) => workspace.scope === "main");
  if (existing) return { workspace: existing, project: project ?? null };
  const ensured = await client.ensureWorkspace(project ? { projectId: project.id } : {});
  const parsed = parseWorkspaces([ensured.workspace ?? ensured])[0];
  if (!parsed) throw codedError("Terminal workspace unavailable", "request_failed");
  return { workspace: parsed, project: project ?? null };
}

function resolveTab(workspace: WorkspaceRecord, value: unknown): TabRecord {
  if (typeof value !== "string" || !value) throw codedError("--tab is required");
  const matches = workspace.tabs.filter((tab) => tab.id === value || tab.name === value);
  if (matches.length !== 1) throw codedError(matches.length > 1 ? "Tab name is ambiguous; use its tab id" : "Tab not found");
  return matches[0]!;
}

function refFor(workspace: WorkspaceRecord, tab: TabRecord): TerminalRef {
  return { workspaceId: workspace.id, tabId: tab.id };
}

const listCommand = defineCommand({
  meta: { name: "list", description: "List terminal tabs grouped by project" },
  args: commonArgs,
  run: async ({ args }) => {
    const json = args.json === true;
    try {
      const client = await clientFromArgs(args);
      const [projects, workspaces] = await Promise.all([client.listProjects(), client.listWorkspaces()]);
      const projectLabels = new Map(parseProjects(projects).map((project) => [project.id, project.label]));
      const parsed = parseWorkspaces(workspaces);
      if (json) {
        console.log(formatCliSuccess({ workspaces: parsed }));
        return;
      }
      if (parsed.every((workspace) => workspace.tabs.length === 0)) {
        console.log("No terminal tabs.");
        return;
      }
      for (const workspace of parsed) {
        console.log(`${workspace.scope === "main" ? "main" : projectLabels.get(workspace.projectId ?? "") ?? workspace.projectId}:`);
        for (const tab of workspace.tabs) console.log(`  ${tab.id}  ${tab.name}  ${tab.status ?? "unknown"}  ${tab.cwd ?? ""}`.trimEnd());
      }
    } catch (err) {
      writeError(err, json);
      process.exitCode = 1;
    }
  },
});

const connectCommand = defineCommand({
  meta: { name: "connect", description: "Connect to one terminal tab" },
  args: {
    project: { type: "string", required: false },
    tab: { type: "string", required: true },
    fromSeq: { type: "string", required: false },
    noMouse: { type: "boolean", required: false, default: false },
    noRichPaste: { type: "boolean", required: false, default: false },
    ...commonArgs,
  },
  run: async ({ args }) => {
    const json = args.json === true;
    try {
      const client = await clientFromArgs(args);
      const { workspace } = await resolveWorkspace(client, args.project);
      const tab = resolveTab(workspace, args.tab);
      const result = await client.attachTab(refFor(workspace, tab), {
        ...(json ? { output: process.stderr, errorOutput: process.stderr } : {}),
        ...(args.noMouse === true ? { mouse: false } : {}),
        ...(args.noRichPaste === true ? { noRichPaste: true } : {}),
        ...(typeof args.fromSeq === "string" && /^\d+$/.test(args.fromSeq) ? { fromSeq: Number(args.fromSeq) } : {}),
        cwd: tab.cwd,
      });
      console.log(json ? formatCliSuccess({ detached: result.detached, terminalRef: refFor(workspace, tab) }) : "Detached.");
    } catch (err) {
      writeError(err, json);
      process.exitCode = 1;
    }
  },
});

const newCommand = defineCommand({
  meta: { name: "new", description: "Create a terminal tab" },
  args: {
    project: { type: "string", required: false },
    name: { type: "string", required: false },
    cwd: { type: "string", required: false },
    attach: { type: "boolean", required: false, default: false },
    ...commonArgs,
  },
  run: async ({ args }) => {
    const json = args.json === true;
    try {
      const client = await clientFromArgs(args);
      const { workspace, project } = await resolveWorkspace(client, args.project);
      const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : "Shell";
      const response = await client.createTab(workspace.id, {
        name,
        cwd: typeof args.cwd === "string" ? args.cwd : project ? `projects/${project.label}` : "",
      });
      const tab = response.tab as TabRecord | undefined;
      if (!tab || !TERMINAL_TAB_ID.test(tab.id)) throw codedError("Invalid terminal tab response", "request_failed");
      const ref = refFor(workspace, tab);
      if (args.attach === true) await client.attachTab(ref, { cwd: tab.cwd });
      console.log(json ? formatCliSuccess({ terminalRef: ref, tab }) : `Created terminal tab ${tab.name} (${tab.id})`);
    } catch (err) {
      writeError(err, json);
      process.exitCode = 1;
    }
  },
});

const removeCommand = defineCommand({
  meta: { name: "rm", description: "Terminate one terminal tab" },
  args: { project: { type: "string", required: false }, tab: { type: "string", required: true }, ...commonArgs },
  run: async ({ args }) => {
    const json = args.json === true;
    try {
      const client = await clientFromArgs(args);
      const { workspace } = await resolveWorkspace(client, args.project);
      const tab = resolveTab(workspace, args.tab);
      await client.terminateTab(refFor(workspace, tab));
      console.log(json ? formatCliSuccess({ terminated: true, terminalRef: refFor(workspace, tab) }) : `Terminated ${tab.name}.`);
    } catch (err) {
      writeError(err, json);
      process.exitCode = 1;
    }
  },
});

export const shellCommand = defineCommand({
  meta: { name: "shell", description: "Manage project-scoped terminal tabs" },
  args: commonArgs,
  subCommands: { ls: listCommand, list: listCommand, new: newCommand, connect: connectCommand, rm: removeCommand },
  run: ({ rawArgs }) => {
    if (!rawArgs?.length) console.log(SHELL_USAGE);
  },
});
