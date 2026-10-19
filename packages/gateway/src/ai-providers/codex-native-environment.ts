import { lstatSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** One owner-bound native profile shared by login, observation, logout and execution. */
export function codexNativeEnvironment(homePath: string, baseEnvironment: Record<string, string>, configuredCodexHome?: string): Record<string, string> {
  const home = resolve(homePath);
  const codexHome = configuredCodexHome ?? join(home, ".codex");
  if (!isAbsolute(codexHome)) throw new Error("Native Codex profile is unavailable");
  const profile = resolve(codexHome), suffix = relative(home, profile);
  if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error("Native Codex profile is unavailable");
  let path = home;
  for (const part of suffix.split(sep)) {
    path = join(path, part);
    try { if (lstatSync(path).isSymbolicLink()) throw new Error("Native Codex profile is unavailable"); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
  const allowed = ["MATRIX_NODE_PREFIX", "PATH", "LANG", "LC_ALL", "TMPDIR"];
  return { ...Object.fromEntries(Object.entries(baseEnvironment).filter(([key]) => allowed.includes(key))), HOME: home, MATRIX_HOME: home, CODEX_HOME: profile };
}
