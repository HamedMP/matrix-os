import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function resolveWithinHome(
  homePath: string,
  requestedPath: string,
): string | null {
  const base = resolve(homePath);
  const target = resolve(base, requestedPath);
  const rel = relative(base, target);

  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return target;
  }

  return null;
}

const DENIED_FILE_API_PREFIXES = ["data/browser-profiles"];

// OS-owned subtrees that must never receive user-created folders. Mirrors
// project-manager.ts's folder-project guard: the home root itself, every
// top-level dot directory (.trash, .hermes, .claude, .ssh, ...), and the
// listed prefixes are owner/tool state, never user workspace content.
const PROTECTED_HOME_PREFIXES = ["system", "agents"];

export function isProtectedHomeSubpath(homePath: string, resolvedPath: string): boolean {
  const rel = relative(resolve(homePath), resolvedPath);
  if (rel === "") return true;
  const firstSegment = rel.split(sep)[0];
  if (firstSegment === undefined) return false;
  if (firstSegment.startsWith(".")) return true;
  return PROTECTED_HOME_PREFIXES.includes(firstSegment);
}

export function isDeniedFileApiPath(homePath: string, requestedPath: string): boolean {
  const resolved = resolveWithinHome(homePath, requestedPath);
  if (!resolved) return true;
  const rel = relative(resolve(homePath), resolved).split(sep).join("/");
  return DENIED_FILE_API_PREFIXES.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));
}

// True when the resolved path is an ancestor of (or equal to) a denied
// subtree: granting it as a workspace root would expose the denied content.
export function containsDeniedFileApiPath(homePath: string, resolvedPath: string): boolean {
  const rel = relative(resolve(homePath), resolvedPath).split(sep).join("/");
  if (rel === "") return true;
  return DENIED_FILE_API_PREFIXES.some((prefix) => prefix === rel || prefix.startsWith(`${rel}/`));
}

function isWithinRealPath(baseReal: string, candidateReal: string): boolean {
  return candidateReal === baseReal || candidateReal.startsWith(`${baseReal}${sep}`);
}

export function resolveExistingFileApiPath(
  homePath: string,
  requestedPath: string,
): string | null {
  if (isDeniedFileApiPath(homePath, requestedPath)) return null;
  const resolved = resolveWithinHome(homePath, requestedPath);
  if (!resolved || !existsSync(resolved)) return null;
  const entry = lstatSync(resolved);
  if (entry.isSymbolicLink()) return null;
  const baseReal = realpathSync(resolve(homePath));
  const targetReal = realpathSync(resolved);
  return isWithinRealPath(baseReal, targetReal) ? resolved : null;
}

export function resolveWritableFileApiPath(
  homePath: string,
  requestedPath: string,
): string | null {
  if (isDeniedFileApiPath(homePath, requestedPath)) return null;
  const resolved = resolveWithinHome(homePath, requestedPath);
  if (!resolved) return null;

  const base = resolve(homePath);
  const baseReal = realpathSync(base);
  const rel = relative(base, resolved);
  const segments = rel.split(sep).filter(Boolean);
  let current = base;
  for (const segment of segments.slice(0, -1)) {
    current = resolve(current, segment);
    if (!existsSync(current)) break;
    const stats = lstatSync(current);
    if (stats.isSymbolicLink()) return null;
    if (!stats.isDirectory()) return null;
    if (!isWithinRealPath(baseReal, realpathSync(current))) return null;
  }

  const parent = dirname(resolved);
  if (existsSync(parent)) {
    const parentStats = lstatSync(parent);
    if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) return null;
    if (!isWithinRealPath(baseReal, realpathSync(parent))) return null;
  }
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) return null;
  return resolved;
}
