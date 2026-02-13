import { isAbsolute, relative, resolve } from "node:path";

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
