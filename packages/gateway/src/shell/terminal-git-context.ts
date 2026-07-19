import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod/v4";
import { PROJECT_SLUG_REGEX } from "../project-manager.js";

const MAX_CACHE_ENTRIES = 128;
const MAX_SESSION_FILES = 256;
const DEFAULT_CACHE_TTL_MS = 30_000;
const GIT_TIMEOUT_MS = 2_000;
const GH_TIMEOUT_MS = 5_000;
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;

const WorkspaceSessionMetadataSchema = z.object({
  projectSlug: z.string().regex(PROJECT_SLUG_REGEX).optional(),
  worktreeId: z.string().regex(/^wt_[a-z0-9]{12,40}$/).optional(),
  pr: z.number().int().positive().optional(),
  runtime: z.object({
    zellijSession: z.string().min(1).max(128).optional(),
  }).passthrough(),
}).passthrough();

const ProjectMetadataSchema = z.object({
  name: z.string().trim().min(1).max(160),
  slug: z.string().regex(PROJECT_SLUG_REGEX),
  localPath: z.string().trim().min(1).max(4096),
  remote: z.string().trim().min(1).max(512).optional(),
  defaultBranch: z.string().trim().min(1).max(256).optional(),
  github: z.object({
    owner: z.string().trim().min(1).max(100),
    repo: z.string().trim().min(1).max(100),
    htmlUrl: z.string().url().max(512),
  }).passthrough().optional(),
}).passthrough();

const WorktreeMetadataSchema = z.object({
  path: z.string().trim().min(1).max(4096),
  currentBranch: z.string().trim().min(1).max(256).optional(),
  pr: z.object({
    number: z.number().int().positive(),
  }).passthrough().optional(),
}).passthrough();

const PullRequestSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url().max(512),
});

export interface TerminalPullRequestContext {
  number: number;
  url?: string;
}

export interface TerminalGitContext {
  project?: string;
  repository?: string;
  branch?: string;
  pullRequest?: TerminalPullRequestContext;
}

export interface TerminalGitContextInput {
  sessionName: string;
  cwd?: string;
}

type RunCommand = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

type WorkspaceContext = {
  cwd?: string;
  context: TerminalGitContext;
};

type GitContext = TerminalGitContext & { repositoryRoot: string };

const execFileAsync = promisify(execFile);

const defaultRunCommand: RunCommand = async (command, args, options) => {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: options.cwd,
    timeout: options.timeout,
    signal: AbortSignal.timeout(options.timeout),
    encoding: "utf8",
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
};

class BoundedTtlCache<T> {
  private readonly entries = new Map<string, { expiresAt: number; value: Promise<T> }>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  getOrLoad(key: string, loader: () => Promise<T>): Promise<T> {
    const current = this.entries.get(key);
    if (current && current.expiresAt > this.now()) {
      this.entries.delete(key);
      this.entries.set(key, current);
      return current.value;
    }
    if (current) this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
    const value = loader();
    this.entries.set(key, { expiresAt: this.now() + this.ttlMs, value });
    return value;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
}

function safeDisplay(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized.slice(0, maxLength) : undefined;
}

function repositoryFromRemote(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  const github = /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim());
  if (github?.[1] && github[2]) return `${github[1]}/${github[2]}`;
  const trimmed = remote.trim().replace(/\/$/, "").replace(/\.git$/, "");
  const segments = trimmed.split(/[/:]/).filter(Boolean);
  return safeDisplay(segments.at(-1), 200);
}

function pullRequestUrl(repository: string | undefined, number: number | undefined): string | undefined {
  if (!repository || !number || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return undefined;
  return `https://github.com/${repository}/pull/${number}`;
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

function mergeContexts(workspace: TerminalGitContext, git: TerminalGitContext | null): TerminalGitContext | null {
  const merged: TerminalGitContext = {
    ...(workspace.project ?? git?.project ? { project: workspace.project ?? git?.project } : {}),
    ...(git?.repository ?? workspace.repository ? { repository: git?.repository ?? workspace.repository } : {}),
    ...(git?.branch ?? workspace.branch ? { branch: git?.branch ?? workspace.branch } : {}),
    ...(git?.pullRequest ?? workspace.pullRequest
      ? { pullRequest: git?.pullRequest ?? workspace.pullRequest }
      : {}),
  };
  return Object.keys(merged).length > 0 ? merged : null;
}

export class TerminalGitContextResolver {
  private readonly homePath: string;
  private readonly runCommand: RunCommand;
  private readonly workspaceCache: BoundedTtlCache<WorkspaceContext | null>;
  private readonly gitCache: BoundedTtlCache<GitContext | null>;

  constructor(options: {
    homePath: string;
    runCommand?: RunCommand;
    cacheTtlMs?: number;
    now?: () => number;
  }) {
    this.homePath = resolve(options.homePath);
    this.runCommand = options.runCommand ?? defaultRunCommand;
    const now = options.now ?? Date.now;
    const ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.workspaceCache = new BoundedTtlCache(MAX_CACHE_ENTRIES, ttlMs, now);
    this.gitCache = new BoundedTtlCache(MAX_CACHE_ENTRIES, ttlMs, now);
  }

  async resolve(input: TerminalGitContextInput): Promise<TerminalGitContext | null> {
    const workspace = await this.workspaceCache.getOrLoad(input.sessionName, () => this.readWorkspaceContext(input.sessionName));
    const requestedCwd = input.cwd ? resolve(input.cwd) : workspace?.cwd;
    const cwd = requestedCwd && isWithin(this.homePath, requestedCwd) ? requestedCwd : undefined;
    if (workspace?.context.pullRequest && !input.cwd) return workspace.context;
    const git = cwd
      ? await this.gitCache.getOrLoad(cwd, () => this.readGitContext(cwd))
      : null;
    return mergeContexts(workspace?.context ?? {}, git);
  }

  private async readWorkspaceContext(sessionName: string): Promise<WorkspaceContext | null> {
    const sessionsDir = join(this.homePath, "system", "sessions");
    let entries;
    try {
      entries = await readdir(sessionsDir, { withFileTypes: true });
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    for (const entry of entries.slice(0, MAX_SESSION_FILES)) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const parsed = WorkspaceSessionMetadataSchema.safeParse(await readJson(join(sessionsDir, entry.name)));
      if (!parsed.success || parsed.data.runtime.zellijSession !== sessionName || !parsed.data.projectSlug) continue;
      const projectValue = await readJson(join(this.homePath, "projects", parsed.data.projectSlug, "config.json"));
      const project = ProjectMetadataSchema.safeParse(projectValue);
      if (!project.success) return null;
      let worktree: z.infer<typeof WorktreeMetadataSchema> | undefined;
      if (parsed.data.worktreeId) {
        const value = await readJson(join(
          this.homePath,
          "projects",
          parsed.data.projectSlug,
          "worktrees",
          parsed.data.worktreeId,
          ".matrix",
          "worktree.json",
        ));
        const parsedWorktree = WorktreeMetadataSchema.safeParse(value);
        if (parsedWorktree.success) worktree = parsedWorktree.data;
      }
      const repository = project.data.github
        ? `${project.data.github.owner}/${project.data.github.repo}`
        : repositoryFromRemote(project.data.remote);
      const prNumber = parsed.data.pr ?? worktree?.pr?.number;
      const context: TerminalGitContext = {
        project: safeDisplay(project.data.name, 160),
        ...(repository ? { repository } : {}),
        ...(worktree?.currentBranch || project.data.defaultBranch
          ? { branch: safeDisplay(worktree?.currentBranch ?? project.data.defaultBranch, 256) }
          : {}),
        ...(prNumber ? {
          pullRequest: {
            number: prNumber,
            ...(pullRequestUrl(repository, prNumber) ? { url: pullRequestUrl(repository, prNumber) } : {}),
          },
        } : {}),
      };
      const rawCwd = worktree?.path ?? project.data.localPath;
      const cwd = isWithin(this.homePath, resolve(rawCwd)) ? resolve(rawCwd) : undefined;
      return { context, ...(cwd ? { cwd } : {}) };
    }
    return null;
  }

  private async readGitContext(cwd: string): Promise<GitContext | null> {
    let repositoryRoot: string;
    let branch: string | undefined;
    try {
      const result = await this.runCommand(
        "git",
        ["rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"],
        { cwd, timeout: GIT_TIMEOUT_MS },
      );
      const [rootLine, branchLine] = result.stdout.split(/\r?\n/, 3);
      if (!rootLine) return null;
      repositoryRoot = resolve(rootLine.trim());
      if (!isWithin(this.homePath, repositoryRoot)) return null;
      branch = branchLine && branchLine.trim() !== "HEAD" ? safeDisplay(branchLine, 256) : undefined;
    } catch (err: unknown) {
      if (!(err instanceof Error)) console.warn("[shell] Git repository lookup failed unexpectedly");
      return null;
    }

    let repository: string | undefined;
    try {
      const remote = await this.runCommand("git", ["remote", "get-url", "origin"], {
        cwd: repositoryRoot,
        timeout: GIT_TIMEOUT_MS,
      });
      repository = repositoryFromRemote(remote.stdout);
    } catch (err: unknown) {
      if (!(err instanceof Error)) console.warn("[shell] Git remote lookup failed unexpectedly");
      repository = undefined;
    }

    let pullRequest: TerminalPullRequestContext | undefined;
    if (branch) {
      try {
        const result = await this.runCommand("gh", ["pr", "view", "--json", "number,url"], {
          cwd: repositoryRoot,
          timeout: GH_TIMEOUT_MS,
        });
        const parsed = PullRequestSchema.safeParse(JSON.parse(result.stdout));
        if (parsed.success) pullRequest = parsed.data;
      } catch (err: unknown) {
        if (!(err instanceof Error)) console.warn("[shell] pull request lookup failed unexpectedly");
        pullRequest = undefined;
      }
    }

    return {
      repositoryRoot,
      project: safeDisplay(basename(repositoryRoot), 160),
      ...(repository ? { repository } : {}),
      ...(branch ? { branch } : {}),
      ...(pullRequest ? { pullRequest } : {}),
    };
  }
}
