import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod/v4";
import { atomicWriteJson, readJsonFile, withProjectLock, type OwnerScope } from "./state-ops.js";

export const PROJECT_SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface ProjectConfig {
  id: string;
  name: string;
  slug: string;
  remote?: string;
  localPath: string;
  defaultBranch?: string;
  addedAt: string;
  updatedAt: string;
  ownerScope: OwnerScope;
  github?: {
    owner: string;
    repo: string;
    htmlUrl: string;
    authState: "unknown" | "ok" | "required" | "rate_limited" | "error";
    lastPrRefreshAt?: string;
    lastBranchRefreshAt?: string;
  };
}

export interface PullRequestSummary {
  number: number;
  title: string;
  author: string | null;
  headRef: string;
  baseRef: string;
  state: string;
}

export interface BranchSummary {
  name: string;
  current?: boolean;
  default?: boolean;
}

export interface WorkspaceError {
  code: string;
  message: string;
}

type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

type Result<T> = { ok: true; status?: number } & T;
type Failure = { ok: false; status: number; error: WorkspaceError };

const DEFAULT_TIMEOUT_MS = 10_000;
const CLONE_TIMEOUT_MS = 5 * 60_000;

const GitHubUrlSchema = z.string().trim().min(1).max(512);
const SlugSchema = z.string().trim().regex(PROJECT_SLUG_REGEX);

const execFileAsync = promisify(execFile);

const defaultRunCommand: CommandRunner = async (command, args, options) => {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: options.cwd,
    timeout: options.timeout,
    encoding: "utf-8",
    maxBuffer: 2 * 1024 * 1024,
  });
  return { stdout, stderr };
};

function genericError(status: number, code: string, message: string): Failure {
  return { ok: false, status, error: { code, message } };
}

function nowIso(now?: () => string): string {
  return now ? now() : new Date().toISOString();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return slug.length > 0 ? slug : `repo-${randomUUID().slice(0, 8)}`;
}

export function validateGitHubUrl(input: string):
  | { ok: true; owner: string; repo: string; htmlUrl: string; cloneUrl: string }
  | { ok: false; code: "invalid_repository_url"; message: string } {
  const parsed = GitHubUrlSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: "invalid_repository_url", message: "Repository URL must point to GitHub" };
  }
  const value = parsed.data;
  const patterns = [
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
    /^github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (!match) continue;
    const owner = match[1];
    const repo = match[2];
    if (!owner || !repo || owner.startsWith(".") || repo.startsWith(".")) break;
    return {
      ok: true,
      owner,
      repo,
      htmlUrl: `https://github.com/${owner}/${repo}`,
      cloneUrl: value.startsWith("git@") ? value : `https://github.com/${owner}/${repo}.git`,
    };
  }
  return { ok: false, code: "invalid_repository_url", message: "Repository URL must point to GitHub" };
}

function projectPath(homePath: string, slug: string): string {
  return join(homePath, "projects", slug);
}

async function readProjectConfig(homePath: string, slug: string): Promise<ProjectConfig | null> {
  try {
    return await readJsonFile<ProjectConfig>(join(projectPath(homePath, slug), "config.json"));
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function normalizePr(raw: unknown): PullRequestSummary | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.number !== "number" || typeof value.title !== "string") return null;
  const author = typeof value.author === "object" && value.author !== null
    ? (value.author as Record<string, unknown>).login
    : null;
  return {
    number: value.number,
    title: value.title,
    author: typeof author === "string" ? author : null,
    headRef: typeof value.headRefName === "string" ? value.headRefName : "",
    baseRef: typeof value.baseRefName === "string" ? value.baseRefName : "",
    state: typeof value.state === "string" ? value.state : "UNKNOWN",
  };
}

export function createProjectManager(options: {
  homePath: string;
  runCommand?: CommandRunner;
  now?: () => string;
}) {
  const homePath = resolve(options.homePath);
  const runCommand = options.runCommand ?? defaultRunCommand;

  return {
    async createProject(input: {
      url: string;
      slug?: string;
      ownerScope?: OwnerScope;
    }): Promise<Result<{ project: ProjectConfig }> | Failure> {
      const github = validateGitHubUrl(input.url);
      if (!github.ok) {
        return genericError(400, github.code, github.message);
      }
      const slug = input.slug ? input.slug.trim() : slugify(github.repo);
      if (!SlugSchema.safeParse(slug).success) {
        return genericError(400, "invalid_slug", "Project slug is invalid");
      }
      return withProjectLock(slug, async () => {
        const targetProjectPath = projectPath(homePath, slug);
        if (await pathExists(targetProjectPath)) {
          return genericError(409, "slug_conflict", "Project slug already exists");
        }

        const stagingRoot = join(homePath, "system", "clone-staging");
        const stagingPath = join(stagingRoot, `${slug}-${randomUUID()}`);
        const repoPath = join(targetProjectPath, "repo");
        await mkdir(stagingRoot, { recursive: true });

        try {
          await runCommand("gh", ["auth", "status"], { cwd: homePath, timeout: DEFAULT_TIMEOUT_MS });
        } catch (err: unknown) {
          if (err instanceof Error) {
            return genericError(401, "github_auth_required", "GitHub authentication is required");
          }
          return genericError(401, "github_auth_required", "GitHub authentication is required");
        }

        try {
          await runCommand("git", ["clone", "--", github.cloneUrl, stagingPath], {
            cwd: stagingRoot,
            timeout: CLONE_TIMEOUT_MS,
          });
          if (!await pathExists(stagingPath)) {
            await mkdir(stagingPath, { recursive: true });
          }
          await mkdir(targetProjectPath, { recursive: true });
          await rename(stagingPath, repoPath);
        } catch (err: unknown) {
          if (err instanceof Error) {
            console.warn("[project-manager] Clone failed:", err.message);
          } else {
            console.warn("[project-manager] Clone failed:", err);
          }
          await rm(stagingPath, { recursive: true, force: true });
          await rm(targetProjectPath, { recursive: true, force: true });
          return genericError(502, "clone_failed", "Repository clone failed");
        }

        const timestamp = nowIso(options.now);
        const project: ProjectConfig = {
          id: `proj_${randomUUID()}`,
          name: github.repo,
          slug,
          remote: input.url,
          localPath: repoPath,
          addedAt: timestamp,
          updatedAt: timestamp,
          ownerScope: input.ownerScope ?? { type: "user", id: "local" },
          github: {
            owner: github.owner,
            repo: github.repo,
            htmlUrl: github.htmlUrl,
            authState: "ok",
          },
        };
        await atomicWriteJson(join(targetProjectPath, "config.json"), project);
        return { ok: true, status: 201, project };
      });
    },

    async listManagedProjects(): Promise<{ projects: ProjectConfig[]; nextCursor: null }> {
      let entries;
      try {
        entries = await readdir(join(homePath, "projects"), { withFileTypes: true });
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return { projects: [], nextCursor: null };
        }
        throw err;
      }

      const projects: ProjectConfig[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const project = await readProjectConfig(homePath, entry.name);
        if (project) projects.push(project);
      }
      projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return { projects, nextCursor: null };
    },

    async getProject(slug: string): Promise<Result<{ project: ProjectConfig }> | Failure> {
      if (!SlugSchema.safeParse(slug).success) {
        return genericError(400, "invalid_slug", "Project slug is invalid");
      }
      const project = await readProjectConfig(homePath, slug);
      if (!project) return genericError(404, "not_found", "Project was not found");
      return { ok: true, project };
    },

    async deleteProject(slug: string): Promise<{ ok: true } | Failure> {
      if (!SlugSchema.safeParse(slug).success) {
        return genericError(400, "invalid_slug", "Project slug is invalid");
      }
      await rm(projectPath(homePath, slug), { recursive: true, force: true });
      return { ok: true };
    },

    async getGithubStatus(): Promise<{ installed: boolean; authenticated: boolean; user: string | null; errorCode: string | null }> {
      try {
        await runCommand("gh", ["--version"], { cwd: homePath, timeout: DEFAULT_TIMEOUT_MS });
      } catch (err: unknown) {
        if (err instanceof Error) console.warn("[project-manager] gh not available:", err.message);
        return { installed: false, authenticated: false, user: null, errorCode: "gh_missing" };
      }
      try {
        await runCommand("gh", ["auth", "status"], { cwd: homePath, timeout: DEFAULT_TIMEOUT_MS });
        const user = await runCommand("gh", ["api", "user", "--jq", ".login"], {
          cwd: homePath,
          timeout: DEFAULT_TIMEOUT_MS,
        });
        return { installed: true, authenticated: true, user: user.stdout.trim() || null, errorCode: null };
      } catch (err: unknown) {
        if (err instanceof Error) console.warn("[project-manager] gh auth status failed:", err.message);
        return { installed: true, authenticated: false, user: null, errorCode: "github_auth_required" };
      }
    },

    async listPullRequests(slug: string): Promise<Result<{ prs: PullRequestSummary[]; refreshedAt: string }> | Failure> {
      const projectResult = await this.getProject(slug);
      if (!projectResult.ok) return projectResult;
      const project = projectResult.project;
      if (!project.github) {
        return genericError(400, "not_github_project", "Project is not linked to GitHub");
      }
      try {
        const result = await runCommand(
          "gh",
          ["pr", "list", "--repo", `${project.github.owner}/${project.github.repo}`, "--json", "number,title,author,headRefName,baseRefName,state"],
          { cwd: project.localPath, timeout: DEFAULT_TIMEOUT_MS },
        );
        const parsed = JSON.parse(result.stdout) as unknown[];
        return {
          ok: true,
          prs: Array.isArray(parsed) ? parsed.map(normalizePr).filter((pr): pr is PullRequestSummary => pr !== null) : [],
          refreshedAt: nowIso(options.now),
        };
      } catch (err: unknown) {
        if (err instanceof Error) console.warn("[project-manager] Failed to list pull requests:", err.message);
        return genericError(502, "github_request_failed", "GitHub request failed");
      }
    },

    async listBranches(slug: string): Promise<Result<{ branches: BranchSummary[]; refreshedAt: string }> | Failure> {
      const projectResult = await this.getProject(slug);
      if (!projectResult.ok) return projectResult;
      try {
        const result = await runCommand("git", ["branch", "--list", "--format=%(refname:short)"], {
          cwd: projectResult.project.localPath,
          timeout: DEFAULT_TIMEOUT_MS,
        });
        return {
          ok: true,
          branches: result.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((name) => ({ name })),
          refreshedAt: nowIso(options.now),
        };
      } catch (err: unknown) {
        if (err instanceof Error) console.warn("[project-manager] Failed to list branches:", err.message);
        return genericError(502, "git_request_failed", "Git request failed");
      }
    },
  };
}
