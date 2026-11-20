// Client-side model for the add-project dialog: GitHub URL parsing, safe
// folder slugs, and branch validation. The gateway revalidates everything;
// these checks exist so the dialog can reject bad input before a request is
// ever sent.

export interface ParsedGitHubUrl {
  owner: string;
  repo: string;
  url: string;
}

const GITHUB_HTTPS_URL_REGEX = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

// https GitHub URLs only. The anchored regex rejects credentials-in-URL
// (user@ / user:pass@), ssh forms, and non-GitHub hosts by construction.
export function parseGitHubHttpsUrl(input: string): ParsedGitHubUrl | null {
  const value = input.trim();
  if (value.length === 0 || value.length > 512) return null;
  const match = GITHUB_HTTPS_URL_REGEX.exec(value);
  if (!match) return null;
  const [, owner, repo] = match;
  if (!owner || !repo || owner.startsWith(".") || repo.startsWith(".")) return null;
  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}

// SAFE_SLUG-style derivation matching the gateway PROJECT_SLUG_REGEX
// (/^[a-z0-9][a-z0-9-]{0,62}$/): lowercase alphanumerics and dashes, never a
// leading dash. May return "" when the input has no usable characters.
export function slugifyProjectName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

export function isValidProjectSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(value);
}

const BRANCH_FORBIDDEN_CHARS = /[\x00-\x20 ~^:?*[\]\\]/;

// Mirror of the gateway's isValidGitBranchName (project-manager.ts). Kept in
// sync by tests/gateway/project-clone-mkdir.test.ts branch cases; the gateway
// remains the enforcing boundary.
export function isValidBranchName(value: string): boolean {
  if (value.length < 1 || value.length > 200) return false;
  if (BRANCH_FORBIDDEN_CHARS.test(value)) return false;
  if (value.startsWith("-") || value.startsWith(".") || value.startsWith("/")) return false;
  if (value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock")) return false;
  if (value.includes("..") || value.includes("@{") || value.includes("//")) return false;
  if (value.split("/").some((component) => component.startsWith(".") || component.endsWith(".lock"))) return false;
  if (value === "@") return false;
  return true;
}

/** The project fields the add-project flow reads, on every OS view. */
export interface AddProjectRecord {
  id?: string;
  slug: string;
  name: string;
  kind?: "scratch" | "github" | "folder";
  localPath?: string;
}

export type FolderPickerChoice =
  | { kind: "choose" }
  | { kind: "blocked"; message: string }
  | { kind: "alternate"; label: string; message: string };

function normalizeFolderPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+/, "").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

// Mirrors the Gateway's protected top-level owner/tool state for presentation.
// This is only a renderer hint; the Gateway remains the security authority.
export function isManagedBrowserPath(path: string): boolean {
  const firstSegment = path.replace(/^\/+/, "").split("/")[0];
  return firstSegment === "system" || firstSegment === "agents" || firstSegment?.startsWith(".") === true;
}

// Mirrors the Gateway's folder-project/new-folder exclusions without making
// ordinary owner workspace paths read-only in the Files browser. In
// particular, MAT-340 deliberately makes projects/** selectable while browser
// profile state remains unavailable as a workspace or folder parent.
export function isProtectedFolderCreationParentPath(path: string): boolean {
  const normalized = normalizeFolderPath(path);
  return isManagedBrowserPath(normalized)
    || normalized === "data/browser-profiles"
    || normalized.startsWith("data/browser-profiles/");
}

export function isProtectedFolderPickerPath(path: string): boolean {
  const normalized = normalizeFolderPath(path);
  return isProtectedFolderCreationParentPath(normalized) || normalized === "data";
}

/** The project already connected at a folder, so the picker offers to open it instead. */
export function projectForFolderPath<P extends AddProjectRecord>(projects: readonly P[], path: string): P | undefined {
  const normalized = normalizeFolderPath(path);
  const exact = projects.find((project) => {
    const localPath = normalizeFolderPath(project.localPath ?? "");
    return localPath === normalized || localPath.endsWith(`/${normalized}`);
  });
  if (exact) return exact;
  // Compatibility only: before MAT-340, projects/<slug> held Matrix-owned
  // metadata while the real checkout lived below it. Keep the Open action
  // for those already-connected legacy projects during lazy migration.
  const segments = normalized.split("/");
  if (segments.length !== 2 || segments[0] !== "projects") return undefined;
  return projects.find((project) => {
    if (project.slug !== segments[1] || project.kind === "folder") return false;
    const localPath = normalizeFolderPath(project.localPath ?? "");
    return localPath === normalized
      || localPath.endsWith(`/${normalized}`)
      || localPath.includes(`/${normalized}/`);
  });
}

// Matrix-owned project metadata now lives in system/projects. Every ordinary
// owner folder is selectable; the Gateway remains the authority for protected
// paths and managed worktree boundaries.
export function resolveProjectFolderChoice(projects: readonly AddProjectRecord[], path: string): FolderPickerChoice {
  const project = projectForFolderPath(projects, path);
  return project
    ? { kind: "alternate", label: `Open ${project.name}`, message: "This folder is already connected to Matrix OS." }
    : { kind: "choose" };
}

/** What the folder picker footer offers for its candidate folder. */
export function folderPickerAction(path: string, resolve?: (path: string) => FolderPickerChoice): {
  choice: FolderPickerChoice | null; label: string; disabled: boolean; canCreateFolder: boolean;
} {
  const resolved = path ? resolve?.(path) ?? { kind: "choose" as const } : null;
  const choice = path && isProtectedFolderPickerPath(path)
    ? { kind: "blocked" as const, message: "This folder is protected by Matrix OS and can't be used as a workspace." }
    : resolved;
  return {
    choice,
    label: choice?.kind === "alternate" ? choice.label : `Choose ${path.split("/").pop() || "Matrix home"}`,
    disabled: choice?.kind === "alternate" ? false : !path || choice?.kind === "blocked",
    canCreateFolder: resolved?.kind === "choose" && !isProtectedFolderCreationParentPath(path),
  };
}
