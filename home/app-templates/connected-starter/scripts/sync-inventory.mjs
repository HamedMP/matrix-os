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
