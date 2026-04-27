import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const src = join(appDir, "node_modules", "@excalidraw", "excalidraw", "dist", "prod", "fonts");
const dest = join(appDir, "public", "excalidraw-assets");

await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });
