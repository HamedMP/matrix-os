import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

// Same canonical JSON contract as gateway collaboration/direct-crypto.ts.
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  return value;
}

export function schemaDigest(tables) {
  if (!tables || typeof tables !== "object" || Array.isArray(tables) || !Object.keys(tables).length) {
    throw new Error("Declare storage.tables before calculating compatibility");
  }
  return createHash("sha256").update(JSON.stringify(sorted(tables))).digest("hex");
}

export async function updateSchemaDigest(appDir, write = false) {
  const path = join(resolve(appDir), "matrix.json");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error("Expected a regular manifest up to 1 MiB");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const digest = schemaDigest(manifest.storage?.tables);
  if (write) {
    if (!manifest.collaboration?.compatibility) throw new Error("Declare collaboration.compatibility first");
    manifest.collaboration.compatibility.schemaDigest = digest;
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: info.mode });
      await rename(temporary, path);
    } finally {
      try { await unlink(temporary); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
  }
  return digest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [appDir, option, ...extra] = process.argv.slice(2);
    if (!appDir || (option && option !== "--write") || extra.length) throw new Error("Usage: node schema-digest.mjs <app-directory> [--write]");
    console.log(await updateSchemaDigest(appDir, option === "--write"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Schema digest unavailable");
    process.exitCode = 1;
  }
}
