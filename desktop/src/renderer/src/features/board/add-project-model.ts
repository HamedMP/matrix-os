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
  if (value === "@") return false;
  return true;
}
