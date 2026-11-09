import { readFile } from "node:fs/promises";
const [file, owner] = process.argv.slice(2);
if (!file || !owner) throw new Error("Usage pairing required");
const config = JSON.parse(await readFile(file, "utf8"));
if (config.desktopExport?.ownerId !== owner)
  throw new Error("Usage owner mismatch");
