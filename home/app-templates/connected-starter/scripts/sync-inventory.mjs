// Repository builds refresh the canonical parser. Owner builds retain its portable snapshot.
import { readFile, writeFile } from "node:fs/promises";
const canonical = new URL(
  "../../../../packages/contracts/src/app-gallery-inventory.ts",
  import.meta.url,
);
const snapshot = new URL("../src/generated-inventory.ts", import.meta.url);
const header =
  "// Generated from packages/contracts/src/app-gallery-inventory.ts. Do not edit.\n";
try {
  const source = await readFile(canonical, "utf8");
  await writeFile(snapshot, header + source);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  const existing = await readFile(snapshot, "utf8");
  if (!existing.startsWith(header))
    throw new Error("Inventory parser snapshot unavailable");
}
for (const [sourceName, targetName] of [["app-gallery-sync", "generated-sync"], ["app-gallery-import", "generated-import"]]) {
  const sourceUrl = new URL(`../../../../packages/contracts/src/${sourceName}.ts`, import.meta.url);
  const targetUrl = new URL(`../src/${targetName}.ts`, import.meta.url);
  const prefix = `// Generated from packages/contracts/src/${sourceName}.ts. Do not edit.\n`;
  try {
    const source = (await readFile(sourceUrl, "utf8"))
      .replaceAll('"./app-gallery-inventory.js"', '"./generated-inventory"')
      .replaceAll('"./app-gallery-sync.js"', '"./generated-sync"')
      .replaceAll('import type { GalleryApp as Definition } from "./app-gallery.js";', 'import type { Definition } from "./types";');
    await writeFile(targetUrl, prefix + source);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if (!(await readFile(targetUrl, "utf8")).startsWith(prefix)) throw new Error("Sync contract snapshot unavailable");
  }
}
