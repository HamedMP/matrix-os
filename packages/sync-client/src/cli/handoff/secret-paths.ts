// Paths a handoff must never copy out of the local working tree. Tracked
// history is already shared with the repository's remote, so this filter only
// guards uncommitted and untracked files that would otherwise ride along in
// the working-tree snapshot.

const EXCLUDED_SEGMENTS = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

const EXCLUDED_BASENAMES = new Set([
  ".DS_Store",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "auth.json",
  "credentials.json",
  "settings.local.json",
]);

const SECRET_EXTENSIONS = new Set([".der", ".jks", ".key", ".p12", ".pfx", ".pem"]);

export function isSafeHandoffPath(inputPath: string): boolean {
  const normalized = inputPath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) return false;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".." || EXCLUDED_SEGMENTS.has(segment))) return false;
  const name = segments.at(-1) ?? "";
  const lower = name.toLowerCase();
  if (EXCLUDED_BASENAMES.has(name)) return false;
  if (lower === ".env" || lower.startsWith(".env.")) return false;
  if (lower === "id_rsa" || lower === "id_ecdsa" || lower === "id_ed25519" || lower.endsWith(".kdbx")) return false;
  const dot = lower.lastIndexOf(".");
  if (dot >= 0 && SECRET_EXTENSIONS.has(lower.slice(dot))) return false;
  return true;
}
