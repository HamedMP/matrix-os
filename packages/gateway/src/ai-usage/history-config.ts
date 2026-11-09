import { lstat, readFile, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { z } from "zod/v4";
import { resolveWithinHome } from "../path-security.js";
const schema = z.object({
  version: z.literal(1),
  sources: z
    .array(
      z.object({
        machine: z.string().min(1).max(80),
        agent: z.enum(["claude", "codex"]),
        path: z.string().min(1).max(4096),
      }),
    )
    .max(100),
});
/** Owner-editable configuration only; never accepts a path from a request or renderer. */
export async function readUsageRootConfig(home: string) {
  const file = join(home, "system", "ai-usage-sources.json");
  let raw: string;
  try {
    const st = await lstat(file);
    if (st.isSymbolicLink() || st.size > 128 * 1024)
      throw new Error("Invalid usage source configuration");
    raw = await readFile(file, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  }
  const config = schema.parse(JSON.parse(raw)),
    base = await realpath(home);
  return Promise.all(
    config.sources.map(async (source) => {
      const path = resolveWithinHome(home, source.path);
      if (!path) throw new Error("Invalid usage source path");
      const actual = await realpath(path);
      const rel = relative(base, actual);
      if (rel.startsWith("..") || isAbsolute(rel))
        throw new Error("Invalid usage source path");
      return { ...source, path };
    }),
  );
}
