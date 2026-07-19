import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod/v4";
import { atomicWriteJson, readJsonFile, withProjectLock, type OwnerScope } from "./state-ops.js";
import { containsDeniedFileApiPath, resolveExistingFileApiPath } from "./path-security.js";

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
  createRequestId?: string;
  createRequestFingerprint?: string;
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

export interface GithubRepoSummary {
  nameWithOwner: string;
  url: string;
  description: string | null;
  primaryLanguage: string | null;
  stargazerCount: number;
  updatedAt: string;
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
type CreateProjectMode = "scratch" | "github" | "folder";

const DEFAULT_TIMEOUT_MS = 10_000;
const CLONE_TIMEOUT_MS = 5 * 60_000;

const GitHubUrlSchema = z.string().trim().min(1).max(512);
const SlugSchema = z.string().trim().regex(PROJECT_SLUG_REGEX);
const CreateRequestIdSchema = z.string().min(5).max(132).regex(/^req_[A-Za-z0-9_-]+$/);

const BRANCH_FORBIDDEN_CHARS = /[\x00-\x20 ~^:?*[\]\\]/;

// git-check-ref-format rules, tightened for CLI safety: a branch is passed
// to `git clone --branch` as a single argv value, so anything ref-illegal or
// option-looking is rejected before it reaches the shell-free execFile call.
export function isValidGitBranchName(value: string): boolean {
  if (value.length < 1 || value.length > 200) return false;
  if (BRANCH_FORBIDDEN_CHARS.test(value)) return false;
  if (value.startsWith("-") || value.startsWith(".") || value.startsWith("/")) return false;
  if (value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock")) return false;
  if (value.includes("..") || value.includes("@{") || value.includes("//")) return false;
  if (value === "@") return false;
  return true;
}

export const GitBranchSchema = z.string().trim().min(1).max(200).refine(isValidGitBranchName);

const execFileAsync = promisify(execFile);

function createRequestFingerprint(input: {
  mode: CreateProjectMode;
  slug: string;
  name?: string;
  repositoryUrl?: string;
  branch?: string;
  ownerScope: OwnerScope;
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function isIdempotentProjectRetry(input: {
  existing: ProjectConfig | null;
  clientRequestId?: string;
  fingerprint: string;
}): ProjectConfig | null {
  return (
    input.existing && input.clientRequestId &&
    input.existing.createRequestId === input.clientRequestId &&
    input.existing.createRequestFingerprint === input.fingerprint
  ) ? input.existing : null;
}

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

function isNotAGitRepositoryError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const stderr = "stderr" in err && typeof (err as { stderr?: unknown }).stderr === "string"
    ? (err as { stderr: string }).stderr
    : "";
  return /not a git repository/i.test(stderr) || /not a git repository/i.test(err.message);
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

// OS-owned subtrees that must never become an agent-accessible project root.
// A folder project's localPath is handed to shells and coding-agent sandboxes
// as a workspace cwd, so granting these would expose kernel/agent state.
const PROTECTED_FOLDER_PROJECT_PREFIXES = ["system", "agents"];

function isProtectedFolderProjectPath(homePath: string, resolvedPath: string): boolean {
  const rel = relative(resolve(homePath), resolvedPath);
  if (rel === "") return true;
  const firstSegment = rel.split(sep)[0];
  if (firstSegment === undefined) return false;
  // Every top-level dot directory under the Matrix home is owner or tool
  // state (.trash, .hermes, .claude, .codex, .ssh, ...), never a user
  // workspace; deny the whole class instead of chasing individual names.
  if (firstSegment.startsWith(".")) return true;
  return PROTECTED_FOLDER_PROJECT_PREFIXES.includes(firstSegment);
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
      url?: string;
      slug?: string;
      name?: string;
      path?: string;
      branch?: string;
      mode?: CreateProjectMode;
      ownerScope?: OwnerScope;
      clientRequestId?: string;
    }): Promise<Result<{ project: ProjectConfig }> | Failure> {
      if (input.clientRequestId && !CreateRequestIdSchema.safeParse(input.clientRequestId).success) {
        return genericError(400, "invalid_request", "Project request is invalid");
      }
      if (input.branch !== undefined && !GitBranchSchema.safeParse(input.branch).success) {
        return genericError(400, "invalid_branch", "Branch name is invalid");
      }
      const mode = input.mode ?? (input.url ? "github" : "scratch");
      if (mode === "folder") {
        const name = input.name?.trim() || "";
        if (!name) return genericError(400, "invalid_project_name", "Project name is required");
        const slug = input.slug ? input.slug.trim() : slugify(name);
        if (!SlugSchema.safeParse(slug).success) {
          return genericError(400, "invalid_slug", "Project slug is invalid");
        }
        const localPath = input.path ? resolveExistingFileApiPath(homePath, input.path) : null;
        if (!localPath) {
          return genericError(400, "invalid_project_path", "Project folder is invalid");
        }
        let realLocalPath: string;
        let realHomePath: string;
        try {
          const stats = await lstat(localPath);
          if (!stats.isDirectory()) {
            return genericError(400, "invalid_project_path", "Project folder is invalid");
          }
          realLocalPath = await realpath(localPath);
          realHomePath = await realpath(homePath);
        } catch (err: unknown) {
          console.warn(
            "[projects] folder project path became unreadable:",
            err instanceof Error ? err.message : String(err),
          );
          return genericError(400, "invalid_project_path", "Project folder is invalid");
        }
        // Check the lexical path AND the fully resolved path against the same
        // rules so a symlinked ancestor cannot alias a protected subtree, and
        // reject any root that would contain the project registry: metadata
        // (config.json, sibling projects) must never live inside an
        // agent-writable workspace.
        for (const candidate of [
          { base: homePath, path: localPath },
          { base: realHomePath, path: realLocalPath },
        ]) {
          const registryEntry = join(candidate.base, "projects", slug);
          if (
            candidate.path === registryEntry
            || candidate.path.startsWith(`${registryEntry}${sep}`)
            || registryEntry.startsWith(`${candidate.path}${sep}`)
            || isProtectedFolderProjectPath(candidate.base, candidate.path)
            // An ancestor of a denied subtree (data/browser-profiles holds
            // persistent browser login state) would expose it as part of the
            // agent-writable workspace.
            || containsDeniedFileApiPath(candidate.base, candidate.path)
          ) {
            return genericError(400, "invalid_project_path", "Project folder is invalid");
          }
          // Inside the registry only the repo checkout (projects/<slug>/repo
          // and below) is user content. The project root holds config.json,
          // and worktrees/ holds Matrix-owned leases and .matrix metadata;
          // none of it may become an agent-writable workspace root.
          const relFromRegistry = relative(join(candidate.base, "projects"), candidate.path);
          const insideRegistry = relFromRegistry !== "" && !relFromRegistry.startsWith("..");
          if (insideRegistry) {
            const segments = relFromRegistry.split(sep);
            if (segments.length === 1 || segments[1] !== "repo") {
              return genericError(400, "invalid_project_path", "Project folder is invalid");
            }
          }
        }
        const metadataPath = projectPath(homePath, slug);
        return withProjectLock(slug, async () => {
          if (await pathExists(metadataPath)) {
            return genericError(409, "slug_conflict", "Project slug already exists");
          }
          await mkdir(metadataPath, { recursive: true });
          const timestamp = nowIso(options.now);
          const project: ProjectConfig = {
            id: `proj_${randomUUID()}`,
            name,
            slug,
            // Persist the fully resolved path: session launches use the stored
            // localPath as cwd/sandbox root without rerunning these checks, so
            // a symlink ancestor repointed at a protected subtree later must
            // not be able to bypass the validation that ran here.
            localPath: realLocalPath,
            addedAt: timestamp,
            updatedAt: timestamp,
            ownerScope: input.ownerScope ?? { type: "user", id: "local" },
          };
          await atomicWriteJson(join(metadataPath, "config.json"), project);
          return { ok: true, status: 201, project };
        });
      }
      if (mode === "scratch") {
        const name = input.name?.trim() || input.slug?.trim() || "";
        if (!name) {
          return genericError(400, "invalid_project_name", "Project name is required");
        }
        const slug = input.slug ? input.slug.trim() : slugify(name);
        if (!SlugSchema.safeParse(slug).success) {
          return genericError(400, "invalid_slug", "Project slug is invalid");
        }
        const ownerScope = input.ownerScope ?? { type: "user" as const, id: "local" };
        const fingerprint = createRequestFingerprint({ mode, slug, name, ownerScope });
        return withProjectLock(slug, async () => {
          const targetProjectPath = projectPath(homePath, slug);
          if (await pathExists(targetProjectPath)) {
            const existing = await readProjectConfig(homePath, slug);
            const idempotentProject = isIdempotentProjectRetry({
              existing,
              clientRequestId: input.clientRequestId,
              fingerprint,
            });
            if (idempotentProject) {
              return { ok: true, status: 200, project: idempotentProject };
            }
            return genericError(409, "slug_conflict", "Project slug already exists");
          }
          const repoPath = join(targetProjectPath, "repo");
          await mkdir(repoPath, { recursive: true });
          const timestamp = nowIso(options.now);
          const project: ProjectConfig = {
            id: `proj_${randomUUID()}`,
            name,
            slug,
            localPath: repoPath,
            addedAt: timestamp,
            updatedAt: timestamp,
            ownerScope,
            createRequestId: input.clientRequestId,
            createRequestFingerprint: input.clientRequestId ? fingerprint : undefined,
          };
          await atomicWriteJson(join(targetProjectPath, "config.json"), project);
          return { ok: true, status: 201, project };
        });
      }

      if (!input.url) {
        return genericError(400, "invalid_repository_url", "Repository URL must point to GitHub");
      }
      const github = validateGitHubUrl(input.url);
      if (!github.ok) {
        return genericError(400, github.code, github.message);
      }
      const slug = input.slug ? input.slug.trim() : slugify(github.repo);
      if (!SlugSchema.safeParse(slug).success) {
        return genericError(400, "invalid_slug", "Project slug is invalid");
      }
      const ownerScope = input.ownerScope ?? { type: "user" as const, id: "local" };
      const fingerprint = createRequestFingerprint({
        mode,
        slug,
        repositoryUrl: github.htmlUrl,
        branch: input.branch,
        ownerScope,
      });
      return withProjectLock(slug, async () => {
        const targetProjectPath = projectPath(homePath, slug);
        if (await pathExists(targetProjectPath)) {
          const existing = await readProjectConfig(homePath, slug);
          const idempotentProject = isIdempotentProjectRetry({
            existing,
            clientRequestId: input.clientRequestId,
            fingerprint,
          });
          if (idempotentProject) {
            return { ok: true, status: 200, project: idempotentProject };
          }
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
          await runCommand(
            "git",
            ["clone", ...(input.branch ? ["--branch", input.branch] : []), "--", github.cloneUrl, stagingPath],
            {
              cwd: stagingRoot,
              timeout: CLONE_TIMEOUT_MS,
            },
          );
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
          ownerScope,
          createRequestId: input.clientRequestId,
          createRequestFingerprint: input.clientRequestId ? fingerprint : undefined,
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
        return { ok: true, prs: [], refreshedAt: nowIso(options.now) };
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
      const refreshedAt = nowIso(options.now);
      // Probe Git itself instead of checking for a local .git entry: a folder
      // project can point at a subdirectory of a repository (monorepo
      // packages) whose .git lives in an ancestor.
      let repoTopLevel: string;
      try {
        const probe = await runCommand("git", ["rev-parse", "--show-toplevel"], {
          cwd: projectResult.project.localPath,
          timeout: DEFAULT_TIMEOUT_MS,
        });
        repoTopLevel = probe.stdout.trim();
      } catch (err: unknown) {
        if (isNotAGitRepositoryError(err)) {
          return { ok: true, branches: [], refreshedAt };
        }
        if (err instanceof Error) console.warn("[project-manager] Failed to probe git worktree:", err.message);
        return genericError(502, "git_request_failed", "Git request failed");
      }
      try {
        // The Matrix home itself is a versioned Git repo; a plain folder that
        // resolves to it as its toplevel has no project branches to show.
        const [homeReal, repoReal] = await Promise.all([realpath(homePath), realpath(repoTopLevel)]);
        if (homeReal === repoReal) {
          return { ok: true, branches: [], refreshedAt };
        }
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

    async listGithubRepos(opts: { search?: string; limit: number }): Promise<{ repos: GithubRepoSummary[] }> {
      const args = [
        "repo", "list",
        "--json", "nameWithOwner,url,description,primaryLanguage,stargazerCount,updatedAt",
        "--limit", String(opts.limit),
      ];
      const result = await runCommand("gh", args, { cwd: homePath, timeout: DEFAULT_TIMEOUT_MS });
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch (err: unknown) {
        console.warn("[project-manager] Failed to parse GitHub repo list:", err instanceof Error ? err.message : typeof err);
        throw new Error("github_repos_unparseable");
      }
      const list = Array.isArray(parsed) ? parsed : [];
      const term = opts.search?.toLowerCase();
      const repos: GithubRepoSummary[] = list
        .map((r: unknown) => {
          const raw = r as Record<string, unknown>;
          return {
            nameWithOwner: String(raw.nameWithOwner ?? ""),
            url: String(raw.url ?? ""),
            description: raw.description != null ? String(raw.description) : null,
            primaryLanguage:
              raw.primaryLanguage != null && typeof raw.primaryLanguage === "object"
                ? (String((raw.primaryLanguage as Record<string, unknown>).name ?? "") || null)
                : typeof raw.primaryLanguage === "string"
                  ? raw.primaryLanguage
                  : null,
            stargazerCount: Number(raw.stargazerCount ?? 0),
            updatedAt: String(raw.updatedAt ?? ""),
          };
        })
        .filter((r) => r.nameWithOwner && (!term || r.nameWithOwner.toLowerCase().includes(term)))
        .slice(0, opts.limit);
      return { repos };
    },
  };
}
