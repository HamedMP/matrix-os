/** Parameter helpers shared by the integration registry files. */

// GitHub repo names follow `owner/repo` where each segment matches GitHub's
// allowed character set: alphanumerics plus `-`, `_`, `.`. We validate strictly
// before URL-encoding to refuse `..`, slashes, or any character that could
// inject extra path segments. Throws synchronously if the input is malformed
// -- the calling /call route will surface this as a 502 with the literal error
// message preserved in logs.
const GITHUB_NAME_RE = /^[A-Za-z0-9._-]+$/;
export function encodeOwnerRepo(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("repo must be a string in owner/name format");
  }
  const parts = value.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`repo must be in owner/name format, got: ${value}`);
  }
  const [owner, repo] = parts;
  if (!GITHUB_NAME_RE.test(owner) || !GITHUB_NAME_RE.test(repo)) {
    throw new Error(`repo contains invalid characters: ${value}`);
  }
  return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

export function cappedPositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), max);
}

export function linearGraphqlBody(query: string, variables?: Record<string, unknown>): Record<string, unknown> {
  return variables ? { query, variables } : { query };
}
