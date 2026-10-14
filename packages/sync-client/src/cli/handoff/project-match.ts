export interface GitHubRepository {
  owner: string;
  repo: string;
}

export interface MatrixProject {
  id: string;
  slug: string;
  name: string;
  kind: string;
  localPath: string;
  remote?: string;
  defaultBranch?: string;
  github?: { owner: string; repo: string };
  archivedAt?: string;
  deletingAt?: string;
}

const GITHUB_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Accepts https, ssh:// and scp-style GitHub remotes; strips credentials and `.git`. */
export function parseGitHubRemote(remote: string): GitHubRepository | null {
  const trimmed = remote.trim();
  let path: string | null = null;
  const scp = /^[A-Za-z0-9._-]+@github\.com:(.+)$/i.exec(trimmed);
  if (scp) path = scp[1] ?? null;
  else {
    try {
      const url = new URL(trimmed);
      if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return null;
      if (url.hostname.toLowerCase() !== "github.com") return null;
      path = url.pathname.replace(/^\/+/, "");
    } catch (error: unknown) {
      if (error instanceof TypeError) return null;
      throw error;
    }
  }
  const segments = (path ?? "").replace(/\/+$/, "").replace(/\.git$/i, "").split("/");
  if (segments.length !== 2) return null;
  const [owner, repo] = segments as [string, string];
  if (!GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repo) || repo === "." || repo === "..") return null;
  return { owner, repo };
}

export function githubHttpsUrl(repository: GitHubRepository): string {
  return `https://github.com/${repository.owner}/${repository.repo}`;
}

function sameGitHub(a: GitHubRepository, b: GitHubRepository): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
}

export function slugBase(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug || "project";
}

/**
 * Stable slug for a repository Matrix cannot clone from GitHub. The root
 * commit makes it identical on every machine that has the same history.
 */
export function fallbackProjectSlug(name: string, rootCommit: string): string {
  const slug = `${slugBase(name)}-${rootCommit.slice(0, 7).toLowerCase()}`;
  if (!SLUG.test(slug)) throw new Error("Derived project slug is invalid");
  return slug;
}

export function findMatchingProject(
  projects: readonly MatrixProject[],
  local: { github: GitHubRepository | null; fallbackSlug: string },
): MatrixProject | null {
  const usable = projects.filter((project) => !project.archivedAt && !project.deletingAt);
  if (local.github) {
    const byGitHub = usable.find((project) => {
      if (project.github && sameGitHub(project.github, local.github!)) return true;
      const remote = project.remote ? parseGitHubRemote(project.remote) : null;
      return remote ? sameGitHub(remote, local.github!) : false;
    });
    if (byGitHub) return byGitHub;
  }
  return usable.find((project) => project.slug === local.fallbackSlug) ?? null;
}

/** Intersection of the gateway's project and worktree branch rules. */
export function isSafeBranchName(branch: string): boolean {
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(branch)) return false;
  if (/^[-./]/.test(branch) || /[./]$/.test(branch) || branch.endsWith(".lock")) return false;
  if (branch.includes("..") || branch.includes("//")) return false;
  return branch.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

/** Matrix-safe name for a local branch; falls back to a commit-derived name. */
export function remoteBranchName(branch: string, head: string): string {
  return isSafeBranchName(branch) ? branch : `handoff/${head.slice(0, 12)}`;
}

/** Side branch used when the Matrix copy of the branch diverged or is dirty. */
export function sideBranchName(branch: string, stamp: string): string {
  const base = branch.replace(/^handoff\//, "").slice(0, 160);
  const name = `handoff/${base}-${stamp}`;
  if (!isSafeBranchName(name)) throw new Error("Derived branch name is invalid");
  return name;
}

/**
 * Origin URL that is safe to store in the Matrix checkout's git config:
 * credentials, query and fragment are removed, and anything that cannot be
 * cleaned (local paths, unknown schemes) is dropped rather than copied.
 */
export function sanitizeRemoteUrl(remote: string | null): string | null {
  if (!remote) return null;
  const trimmed = remote.trim();
  const github = parseGitHubRemote(trimmed);
  if (github) return githubHttpsUrl(github);
  // scp-style `git@host:path` carries a login name, not a secret.
  if (/^[A-Za-z0-9._-]{1,64}@[A-Za-z0-9.-]{1,253}:[A-Za-z0-9._~/-]{1,400}$/.test(trimmed) && !trimmed.includes("..")) return trimmed;
  try {
    const url = new URL(trimmed);
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol) || !url.hostname) return null;
    const user = url.protocol === "ssh:" && !url.password ? url.username : "";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    if (user) url.username = user;
    const cleaned = url.toString();
    return cleaned.length <= 512 && !/[\u0000-\u001f\u007f]/.test(cleaned) ? cleaned : null;
  } catch (error: unknown) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}
