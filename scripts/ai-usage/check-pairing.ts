import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { prepareIncoming } from "./incoming";
const [file, owner, incomingId] = process.argv.slice(2);
if (!file || !owner) throw new Error("Usage pairing required");
const config = JSON.parse(await readFile(file, "utf8"));
if (config.desktopExport?.ownerId !== owner)
  throw new Error("Usage owner mismatch");

if (incomingId) await prepareIncoming(dirname(resolve(file)), incomingId);
