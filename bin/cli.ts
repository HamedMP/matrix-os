import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const COMMANDS = new Set([
  "start",
  "send",
  "status",
  "doctor",
  "tui",
  "help",
  "version",
  "project",
  "worktree",
  "workspace",
  "session",
  "agent",
  "review",
  "task",
  "preview",
]);

export interface ParsedArgs {
  command: string;
  subcommand?: string;
  positional: string[];
  message?: string;
  gateway: string;
  token?: string;
  shell?: boolean;
  session?: string;
  noStream?: boolean;
  slug?: string;
  project?: string;
  branch?: string;
  pr?: number;
  confirmDirtyDelete?: boolean;
  confirm?: string;
  includeTranscripts?: boolean;
  agent?: string;
  task?: string;
  worktree?: string;
  terminal?: boolean;
  statusFilter?: string;
  priority?: string;
  label?: string;
  url?: string;
}

export interface WorkspaceRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
}

interface ProjectListResponse {
  projects: Array<{
    slug?: string;
    name?: string;
    github?: { owner?: string; repo?: string };
    updatedAt?: string;
  }>;
  nextCursor?: string | null;
}

interface WorktreeListResponse {
  worktrees: Array<{
    id?: string;
    currentBranch?: string;
    dirtyState?: string;
    path?: string;
  }>;
}

export interface StatusInfo {
  healthy: boolean;
  error?: string;
  health?: { status: string; cronJobs: number; channels: Record<string, boolean> };
  systemInfo?: {
    version: string;
    uptime: number;
    modules: number;
    channels: Record<string, boolean>;
    skills: number;
    todayCost: number;
  };
  channels?: Record<string, { status: string }>;
  cronJobs?: Array<{ id: string; message: string; schedule: { type: string; expression?: string } }>;
}

export interface DoctorCheck {
  name: string;
  passed: boolean;
  detail: string;
  fix?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: "help",
    positional: [],
    gateway: "http://localhost:4000",
  };

  if (argv.length === 0) return result;

  let positionalIndex = 0;
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "--version") {
      result.command = "version";
      i++;
      continue;
    }

    if (arg === "--help") {
      result.command = "help";
      i++;
      continue;
    }

    if (arg === "--gateway" && i + 1 < argv.length) {
      result.gateway = argv[i + 1];
      i += 2;
      continue;
    }

    if (arg === "--token" && i + 1 < argv.length) {
      result.token = argv[i + 1];
      i += 2;
      continue;
    }

    if (arg === "--shell") {
      result.shell = true;
      i++;
      continue;
    }

    if (arg === "--session" && i + 1 < argv.length) {
      result.session = argv[i + 1];
      i += 2;
      continue;
    }

    if (arg === "--slug" && i + 1 < argv.length) {
      result.slug = argv[i + 1];
      i += 2;
      continue;
    }

    if (arg === "--project" && i + 1 < argv.length) {
      result.project = argv[i + 1];
      i += 2;
      continue;
    }

    if (arg === "--agent" && i + 1 < argv.length) {
      result.agent = argv[i + 1];
      i += 2;
      continue;
    }

    if (arg === "--task" && i + 1 < argv.length) {
      result.task = argv[i + 1];
      i += 2;
      continue;
    }

    if (arg === "--worktree" && i + 1 < argv.length) {
      result.worktree = argv[i + 1];
      i += 2;
      continue;
    }

    if (arg === "--terminal") {
      result.terminal = true;
      i++;
      continue;
    }

    if (arg === "--status" && i + 1 < argv.length) {
      result.statusFilter = argv[i + 1];
      i += 2;
      continue;
    }

    if (arg === "--priority" && i + 1 < argv.length) {
      result.priority = argv[i + 1];
      i += 2;
      continue;
    }

    if (arg === "--label" && i + 1 < argv.length) {
      result.label = argv[i + 1];
      i += 2;
      continue;
    }

    if (arg === "--url" && i + 1 < argv.length) {
      result.url = argv[i + 1];
      i += 2;
      continue;
    }

    if (arg === "--branch" && i + 1 < argv.length) {
      result.branch = argv[i + 1];
      i += 2;
      continue;
    }

    if (arg === "--pr" && i + 1 < argv.length) {
      const pr = Number.parseInt(argv[i + 1], 10);
      if (Number.isSafeInteger(pr) && pr > 0) {
        result.pr = pr;
      }
      i += 2;
      continue;
    }

    if (arg === "--confirm" && i + 1 < argv.length) {
      result.confirm = argv[i + 1];
      i += 2;
      continue;
    }

    if (arg === "--confirm-dirty-delete") {
      result.confirmDirtyDelete = true;
      i++;
      continue;
    }

    if (arg === "--include-transcripts") {
      result.includeTranscripts = true;
      i++;
      continue;
    }

    if (arg === "--no-stream") {
      result.noStream = true;
      i++;
      continue;
    }

    if (positionalIndex === 0) {
      if (COMMANDS.has(arg)) {
        result.command = arg;
      } else {
        result.command = "help";
      }
      positionalIndex++;
    } else if (
      positionalIndex === 1 &&
      ["project", "worktree", "workspace", "session", "agent", "review", "task", "preview"].includes(result.command)
    ) {
      result.subcommand = arg;
      positionalIndex++;
    } else if (positionalIndex === 1 && result.command === "send") {
      result.message = arg;
      positionalIndex++;
    } else if (["project", "worktree", "workspace", "session", "agent", "review", "task", "preview"].includes(result.command)) {
      result.positional.push(arg);
      positionalIndex++;
    }

    i++;
  }

  return result;
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function queryString(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded.length > 0 ? `?${encoded}` : "";
}

function requirePositional(args: ParsedArgs, index: number, label: string): string {
  const value = args.positional[index];
  if (!value) {
    throw new Error(`${label} required`);
  }
  return value;
}

export function buildWorkspaceRequest(args: ParsedArgs): WorkspaceRequest {
  if (args.command === "project") {
    switch (args.subcommand) {
      case "add": {
        const url = requirePositional(args, 0, "repository URL");
        return {
          method: "POST",
          path: "/api/projects",
          body: args.slug ? { url, slug: args.slug } : { url },
        };
      }
      case "ls":
      case "list":
        return { method: "GET", path: "/api/projects" };
      case "prs": {
        const slug = encodePathSegment(requirePositional(args, 0, "project slug"));
        return { method: "GET", path: `/api/projects/${slug}/prs` };
      }
      case "branches": {
        const slug = encodePathSegment(requirePositional(args, 0, "project slug"));
        return { method: "GET", path: `/api/projects/${slug}/branches` };
      }
      case "rm":
      case "delete": {
        const slug = encodePathSegment(requirePositional(args, 0, "project slug"));
        return { method: "DELETE", path: `/api/projects/${slug}` };
      }
      default:
        throw new Error("Unknown project command");
    }
  }

  if (args.command === "worktree") {
    switch (args.subcommand) {
      case "create": {
        const slug = encodePathSegment(requirePositional(args, 0, "project slug"));
        if ((args.branch ? 1 : 0) + (typeof args.pr === "number" ? 1 : 0) !== 1) {
          throw new Error("Exactly one of --branch or --pr is required");
        }
        return {
          method: "POST",
          path: `/api/projects/${slug}/worktrees`,
          body: args.branch ? { branch: args.branch } : { pr: args.pr },
        };
      }
      case "ls":
      case "list": {
        const slug = encodePathSegment(requirePositional(args, 0, "project slug"));
        return { method: "GET", path: `/api/projects/${slug}/worktrees` };
      }
      case "rm":
      case "delete": {
        const slug = encodePathSegment(requirePositional(args, 0, "project slug"));
        const worktreeId = encodePathSegment(requirePositional(args, 1, "worktree ID"));
        return {
          method: "DELETE",
          path: `/api/projects/${slug}/worktrees/${worktreeId}`,
          body: { confirmDirtyDelete: args.confirmDirtyDelete === true },
        };
      }
      default:
        throw new Error("Unknown worktree command");
    }
  }

  if (args.command === "workspace") {
    switch (args.subcommand) {
      case "export":
        return {
          method: "POST",
          path: "/api/workspace/export",
          body: args.project
            ? { scope: "project", projectSlug: args.project, includeTranscripts: args.includeTranscripts === true }
            : { scope: "all", includeTranscripts: args.includeTranscripts === true },
        };
      case "delete": {
        if (!args.project) {
          throw new Error("--project required");
        }
        return {
          method: "DELETE",
          path: "/api/workspace/data",
          body: {
            scope: "project",
            projectSlug: args.project,
            confirmation: args.confirm ?? "",
          },
        };
      }
      case "events":
        return {
          method: "GET",
          path: `/api/workspace/events${queryString({
            projectSlug: args.project,
            taskId: args.task,
            status: args.statusFilter,
          })}`,
        };
      default:
        throw new Error("Unknown workspace command");
    }
  }

  if (args.command === "session") {
    switch (args.subcommand) {
      case "start": {
        const prompt = args.positional[0];
        return {
          method: "POST",
          path: "/api/sessions",
          body: {
            kind: args.agent ? "agent" : "shell",
            ...(args.agent ? { agent: args.agent } : {}),
            ...(args.project ? { projectSlug: args.project } : {}),
            ...(args.task ? { taskId: args.task } : {}),
            ...(args.worktree ? { worktreeId: args.worktree } : {}),
            ...(typeof args.pr === "number" ? { pr: args.pr } : {}),
            ...(prompt ? { prompt } : {}),
          },
        };
      }
      case "ls":
      case "list":
        return {
          method: "GET",
          path: `/api/sessions${queryString({
            projectSlug: args.project,
            taskId: args.task,
            pr: args.pr,
            status: args.statusFilter,
          })}`,
        };
      case "get":
      case "attach": {
        const sessionId = encodePathSegment(requirePositional(args, 0, "session ID"));
        return { method: "GET", path: `/api/sessions/${sessionId}` };
      }
      case "send": {
        const sessionId = encodePathSegment(requirePositional(args, 0, "session ID"));
        const input = requirePositional(args, 1, "input");
        return { method: "POST", path: `/api/sessions/${sessionId}/send`, body: { input } };
      }
      case "observe": {
        const sessionId = encodePathSegment(requirePositional(args, 0, "session ID"));
        return { method: "POST", path: `/api/sessions/${sessionId}/observe`, body: {} };
      }
      case "takeover": {
        const sessionId = encodePathSegment(requirePositional(args, 0, "session ID"));
        return { method: "POST", path: `/api/sessions/${sessionId}/takeover`, body: {} };
      }
      case "kill":
      case "rm": {
        const sessionId = encodePathSegment(requirePositional(args, 0, "session ID"));
        return { method: "DELETE", path: `/api/sessions/${sessionId}`, body: {} };
      }
      default:
        throw new Error("Unknown session command");
    }
  }

  if (args.command === "agent") {
    switch (args.subcommand) {
      case "ls":
      case "list":
        return { method: "GET", path: "/api/agents" };
      case "sandbox-status":
        return { method: "GET", path: "/api/agents/sandbox-status" };
      default:
        throw new Error("Unknown agent command");
    }
  }

  if (args.command === "task") {
    switch (args.subcommand) {
      case "create": {
        if (!args.project) throw new Error("--project required");
        const title = requirePositional(args, 0, "task title");
        return {
          method: "POST",
          path: `/api/projects/${encodePathSegment(args.project)}/tasks`,
          body: {
            title,
            ...(args.priority ? { priority: args.priority } : {}),
          },
        };
      }
      case "ls":
      case "list":
        if (!args.project) throw new Error("--project required");
        return { method: "GET", path: `/api/projects/${encodePathSegment(args.project)}/tasks` };
      case "archive": {
        if (!args.project) throw new Error("--project required");
        const taskId = encodePathSegment(requirePositional(args, 0, "task ID"));
        return {
          method: "PATCH",
          path: `/api/projects/${encodePathSegment(args.project)}/tasks/${taskId}`,
          body: { status: "archived" },
        };
      }
      case "rm":
      case "delete": {
        if (!args.project) throw new Error("--project required");
        const taskId = encodePathSegment(requirePositional(args, 0, "task ID"));
        return {
          method: "DELETE",
          path: `/api/projects/${encodePathSegment(args.project)}/tasks/${taskId}`,
          body: {},
        };
      }
      case "work": {
        if (!args.project) throw new Error("--project required");
        const taskId = requirePositional(args, 0, "task ID");
        return {
          method: "POST",
          path: "/api/sessions",
          body: {
            kind: args.agent ? "agent" : "shell",
            ...(args.agent ? { agent: args.agent } : {}),
            projectSlug: args.project,
            taskId,
          },
        };
      }
      default:
        throw new Error("Unknown task command");
    }
  }

  if (args.command === "preview") {
    switch (args.subcommand) {
      case "add": {
        if (!args.project) throw new Error("--project required");
        if (!args.url) throw new Error("--url required");
        return {
          method: "POST",
          path: `/api/projects/${encodePathSegment(args.project)}/previews`,
          body: {
            ...(args.task ? { taskId: args.task } : {}),
            label: args.label ?? args.url,
            url: args.url,
          },
        };
      }
      case "ls":
      case "list":
        if (!args.project) throw new Error("--project required");
        return {
          method: "GET",
          path: `/api/projects/${encodePathSegment(args.project)}/previews${queryString({ taskId: args.task })}`,
        };
      case "rm":
      case "delete": {
        if (!args.project) throw new Error("--project required");
        const previewId = encodePathSegment(requirePositional(args, 0, "preview ID"));
        return {
          method: "DELETE",
          path: `/api/projects/${encodePathSegment(args.project)}/previews/${previewId}`,
          body: {},
        };
      }
      default:
        throw new Error("Unknown preview command");
    }
  }

  if (args.command === "review") {
    switch (args.subcommand) {
      case "start": {
        if (!args.project) throw new Error("--project required");
        if (!args.worktree) throw new Error("--worktree required");
        if (typeof args.pr !== "number") throw new Error("--pr required");
        const reviewer = args.agent ?? "claude";
        return {
          method: "POST",
          path: "/api/reviews",
          body: {
            projectSlug: args.project,
            worktreeId: args.worktree,
            pr: args.pr,
            reviewer,
            implementer: reviewer,
            maxRounds: 5,
            convergenceGate: "findings_only",
            verificationCommands: [],
          },
        };
      }
      case "ls":
      case "list":
        return { method: "GET", path: `/api/reviews${queryString({ projectSlug: args.project })}` };
      case "status":
      case "watch": {
        const reviewId = encodePathSegment(requirePositional(args, 0, "review ID"));
        return { method: "GET", path: `/api/reviews/${reviewId}` };
      }
      case "next":
      case "approve":
      case "stop": {
        const reviewId = encodePathSegment(requirePositional(args, 0, "review ID"));
        return { method: "POST", path: `/api/reviews/${reviewId}/${args.subcommand}`, body: {} };
      }
      default:
        throw new Error("Unknown review command");
    }
  }

  throw new Error("Unknown workspace command");
}

export function formatProjectList(response: ProjectListResponse): string {
  if (response.projects.length === 0) {
    return "No projects";
  }
  return response.projects
    .map((project) => {
      const slug = project.slug ?? "-";
      const name = project.name ?? slug;
      const remote = project.github?.owner && project.github.repo
        ? `${project.github.owner}/${project.github.repo}`
        : "-";
      return `${slug}\t${name}\t${remote}`;
    })
    .join("\n");
}

export function formatWorktreeList(response: WorktreeListResponse): string {
  if (response.worktrees.length === 0) {
    return "No worktrees";
  }
  return response.worktrees
    .map((worktree) => {
      const id = worktree.id ?? "-";
      const branch = worktree.currentBranch ?? "-";
      const dirty = worktree.dirtyState ?? "unknown";
      return `${id}\t${branch}\t${dirty}`;
    })
    .join("\n");
}

export function formatWorkspaceResponse(command: string, subcommand: string | undefined, data: unknown): string {
  if (command === "project" && (subcommand === "ls" || subcommand === "list")) {
    return formatProjectList(data as ProjectListResponse);
  }
  if (command === "worktree" && (subcommand === "ls" || subcommand === "list")) {
    return formatWorktreeList(data as WorktreeListResponse);
  }
  return JSON.stringify(data, null, 2);
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export function formatStatus(info: StatusInfo): string {
  const lines: string[] = [];

  if (!info.healthy) {
    lines.push("Gateway: unreachable");
    if (info.error) lines.push(`  Error: ${info.error}`);
    return lines.join("\n");
  }

  lines.push("Gateway: healthy");

  if (info.systemInfo) {
    const si = info.systemInfo;
    lines.push(`  Version:  ${si.version}`);
    lines.push(`  Uptime:   ${formatUptime(si.uptime)}`);
    lines.push(`  Modules:  ${si.modules}`);
    lines.push(`  Skills:   ${si.skills}`);
    lines.push(`  Cost:     $${si.todayCost.toFixed(2)}`);
  }

  if (info.channels) {
    lines.push("");
    lines.push("Channels:");
    for (const [name, ch] of Object.entries(info.channels)) {
      lines.push(`  ${name}: ${ch.status}`);
    }
  }

  if (info.cronJobs && info.cronJobs.length > 0) {
    lines.push("");
    lines.push("Cron Jobs:");
    for (const job of info.cronJobs) {
      const sched = job.schedule.expression ?? job.schedule.type;
      lines.push(`  [${job.id}] ${job.message} (${sched})`);
    }
  }

  return lines.join("\n");
}

export function formatDoctor(checks: DoctorCheck[]): string {
  const lines: string[] = [];
  const passed = checks.filter((c) => c.passed).length;
  const failed = checks.filter((c) => !c.passed).length;

  for (const check of checks) {
    const marker = check.passed ? "PASS" : "FAIL";
    lines.push(`  [${marker}] ${check.name}: ${check.detail}`);
    if (!check.passed && check.fix) {
      lines.push(`         Fix: ${check.fix}`);
    }
  }

  lines.push("");
  lines.push(`${passed} passed, ${failed} failed`);

  if (failed === 0) {
    lines.push("All checks passed");
  }

  return lines.join("\n");
}

export function getVersion(): string {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      return "0.0.0";
    }
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return "0.0.0";
    }
    console.warn("[matrixos] Failed to read package version:", err instanceof Error ? err.message : String(err));
    return "0.0.0";
  }
}

export function getHelpText(): string {
  return `Matrix OS CLI

Usage: matrixos <command> [options]

Commands:
  start       Start the gateway (and optionally the shell)
  send        Send a message to the kernel
  status      Show gateway health and status
  doctor      Run diagnostic checks
  tui         Open the workspace dashboard
  project     Manage coding projects
  worktree    Manage project worktrees
  session     Manage coding sessions
  agent       Inspect agent runtime status
  review      Manage review loops
  task        Manage project tasks
  preview     Manage project previews
  workspace   Export or delete workspace data
  help        Show this help text
  version     Show version

Options:
  --gateway URL    Gateway URL (default: http://localhost:4000)
  --token TOKEN    Auth token for gateway requests

Start options:
  --shell          Also start the Next.js shell

Send options:
  --session ID     Send to a specific session
  --no-stream      Wait for complete response

Project commands:
  project add <github-url> [--slug slug]
  project ls
  project prs <slug>
  project branches <slug>
  project rm <slug>

Worktree commands:
  worktree create <slug> (--branch name | --pr number)
  worktree ls <slug>
  worktree rm <slug> <worktreeId> [--confirm-dirty-delete]

Workspace commands:
  workspace export [--project slug] [--include-transcripts]
  workspace delete --project slug --confirm "delete project workspace data"
  workspace events [--project slug] [--task id]

Session commands:
  session start [prompt] [--project slug] [--worktree id] [--task id] [--pr number] [--agent codex]
  session ls [--project slug] [--task id] [--status running]
  session attach <sessionId>
  session observe <sessionId>
  session takeover <sessionId>
  session send <sessionId> <input>
  session kill <sessionId>

Agent commands:
  agent ls
  agent sandbox-status

Review commands:
  review start --project slug --worktree id --pr number [--agent claude]
  review status <reviewId>
  review watch <reviewId>
  review next <reviewId>
  review approve <reviewId>
  review stop <reviewId>

Task commands:
  task create "<title>" --project slug [--priority high]
  task ls --project slug
  task work <taskId> --project slug [--agent codex]
  task archive <taskId> --project slug
  task rm <taskId> --project slug

Preview commands:
  preview add --project slug --url URL [--label label] [--task id]
  preview ls --project slug [--task id]
  preview rm <previewId> --project slug`;
}
