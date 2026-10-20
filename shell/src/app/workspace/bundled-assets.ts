import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const WALLPAPERS = ["matrix-dawn.webp", "matrix-dusk.webp", "matrix-night.webp", "moraine-lake.jpg", "xp-bliss.jpg", "win11-bloom.jpg", "macos-light.svg"];
const SURFACE_ASSETS: Record<string, readonly string[]> = {
  v2: ["canvas.png", "chat.png", "browser.png", "notes.png", "editor.png", "plugins.png", "whiteboard.png", "create-app.png", "files.png", "terminal.png", "settings.png", "desktop.png", "launcher.png"],
  v3: ["canvas.png", "desktop.png", "discord.svg"],
};
const TYPES: Record<string, string> = { png: "image/png", svg: "image/svg+xml", jpg: "image/jpeg", webp: "image/webp" };
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

/** Only installation-owned OS assets. MATRIX_HOME and owner files are never read. */
export async function readSharedBundledAsset(path: string[], query: URLSearchParams): Promise<Response | null> {
  let kind: "icons" | "wallpapers" | "surfaces";
  let name: string;
  let surfaceVersion: string | undefined;
  if (path.length === 2 && path[0] === "icons") { kind = "icons"; name = path[1]!; }
  else if (path.length === 3 && path[0] === "system-app-icons" && (path[1] === "v2" || path[1] === "v3")) { kind = "surfaces"; surfaceVersion = path[1]; name = path[2]!; }
  else if (path.join("/") === "api/files/blob" && query.getAll("path").length === 1) {
    const match = /^system\/(icons|wallpapers)\/([^/]+)$/.exec(query.get("path")!);
    if (!match) return null;
    kind = match[1] as "icons" | "wallpapers"; name = match[2]!;
  } else return null;
  if (!/^[A-Za-z0-9_-]{1,80}\.(png|svg|jpg|webp)$/.test(name)) return null;
  if (kind === "wallpapers" && !WALLPAPERS.includes(name)) return null;
  if (kind === "icons" && !/\.(png|svg)$/.test(name)) return null;
  if (kind === "surfaces" && !SURFACE_ASSETS[surfaceVersion!]?.includes(name)) return null;
  const cwd = process.cwd();
  const installation = process.env.MATRIX_SHARED_WORKSPACE_BUNDLE_ROOT ?? (basename(cwd) === "shell" ? dirname(cwd) : cwd);
  const directory = kind === "surfaces" ? join(installation, "shell/public/system-app-icons", surfaceVersion!) : join(installation, "home/system", kind);
  try {
    const root = await realpath(directory);
    const filename = resolve(root, name);
    const canonical = await realpath(filename);
    const within = relative(root, canonical);
    if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) return null;
    // Refuse final symlinks; the descriptor avoids a file swap between stat/read.
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_ASSET_BYTES) return null;
      const bytes = await file.readFile();
      if (bytes.length > MAX_ASSET_BYTES) return null;
      return new Response(bytes, { headers: {
        "Content-Type": TYPES[name.split(".").at(-1)!]!, "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox",
      } });
    } finally { await file.close(); }
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["ENOENT", "ENOTDIR", "ELOOP"].includes(code ?? "")) {
      console.warn("[workspace] Bundled asset unavailable", error instanceof Error ? error.name : "UnknownError");
    }
    return null;
  }
}
