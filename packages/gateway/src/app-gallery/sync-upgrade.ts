import { createHash, randomUUID } from "node:crypto";
import { rename, unlink } from "node:fs/promises";
import type { GalleryApp } from "@matrix-os/contracts/app-gallery";
import { createPrivateStage, DEFAULT_LIMITS, isFsError, pinDirectory } from "./filesystem.js";
import type { PinnedDirectory } from "./pinned-directory.js";
import { withOwnerFileMutation } from "../owner-file-mutations.js";

export interface LegacyGalleryTemplate { files: Record<string, string>; html: string }
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const placeholder = "__MATRIX_APP_DEFINITION__";
function inject(html: string, definition: unknown) {
  if (html.split(placeholder).length !== 2) throw new Error("Starter template unavailable");
  const json = JSON.stringify(definition).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  return Buffer.from(html.replace(placeholder, () => json));
}
async function parent(root: PinnedDirectory, path: string, create = false) {
  const parts = path.split("/"), name = parts.pop()!;
  const opened: PinnedDirectory[] = []; // At most 16 pinned ancestors per bounded template path.
  let current = root;
  try {
    if (parts.length > 16 || [...parts, name].some(p => !p || p === "." || p === ".." || /[\\\u0000-\u001f\u007f]/.test(p))) throw new Error("Invalid template path");
    for (const part of parts) { current = create ? await current.ensureChild(part) : await current.child(part); opened.push(current); }
    return { directory: current, name, close: async () => { for (const d of opened.reverse()) await d.close(); } };
  } catch (error) { for (const d of opened.reverse()) await d.close(); throw error; }
}
async function read(root: PinnedDirectory, path: string): Promise<Buffer | null> {
  let leaf;
  try { leaf = await parent(root, path); return await leaf.directory.readFile(leaf.name, DEFAULT_LIMITS.maxFileBytes); }
  catch (error) { if (isFsError(error, "ENOENT")) return null; throw error; }
  finally { await leaf?.close(); }
}

/** Upgrade only a byte-verified shipped starter. Unknown/custom files, config and all Postgres data are preserved.
 * Publish the runtime HTML last: an interrupted copy continues serving its old assets and is resumable.
 * Ordinary owner file mutations share this lock; direct same-UID filesystem access is the existing privileged boundary.
 */
export async function upgradeGalleryStarters(options: {
  homePath: string; apps: readonly GalleryApp[]; files: Map<string, Buffer>; legacy: LegacyGalleryTemplate;
}): Promise<{ updated: string[]; preserved: string[] }> {
  const result = { updated: [] as string[], preserved: [] as string[] };
  for (const app of options.apps) {
    if (!app.services.length) continue;
    await withOwnerFileMutation(options.homePath, async () => {
      const home = await pinDirectory(options.homePath);
      let apps, installed;
      try {
        try { apps = await home.child("apps"); installed = await apps.child(app.id); }
        catch (error) { if (isFsError(error, "ENOENT")) return; throw error; }
        const definitionBytes = await read(installed, "src/definition.json");
        if (!definitionBytes) return;
        const definition = JSON.parse(definitionBytes.toString("utf8"));
        const { iconDataUrl: _icon, ...original } = definition;
        if (JSON.stringify(original) !== JSON.stringify(app)) { result.preserved.push(app.id); return; }
        const manifestBytes = await read(installed, "matrix.json");
        if (!manifestBytes || JSON.parse(manifestBytes.toString("utf8")).slug !== app.id) return;
        const next = new Map(options.files); // At most DEFAULT_LIMITS.maxFiles from the bounded bundled template.
        next.delete("src/definition.json");
        next.set("dist/index.html", inject(next.get("dist/index.html")!.toString("utf8"), definition));
        const currentHtml = await read(installed, "dist/index.html");
        if (!currentHtml) return;
        if (currentHtml.equals(next.get("dist/index.html")!)) return;
        if (!currentHtml.equals(inject(options.legacy.html, definition))) { result.preserved.push(app.id); return; }
        for (const [path, expected] of Object.entries(options.legacy.files)) {
          const current = await read(installed, path);
          if (!current || hash(current) !== expected && (!next.has(path) || !current.equals(next.get(path)!))) { result.preserved.push(app.id); return; }
        }
        // Never overwrite a user-created file that collides with a newly introduced module/asset.
        for (const [path, bytes] of next) {
          if (Object.hasOwn(options.legacy.files, path) || path === "dist/index.html") continue;
          const current = await read(installed, path);
          if (current && !current.equals(bytes)) { result.preserved.push(app.id); return; }
        }
        const stage = await createPrivateStage(home);
        try {
          const prepared: { path: string; staged: string }[] = [];
          for (const [path, bytes] of next) prepared.push({ path, staged: await stage.write(bytes) });
          prepared.sort((a, b) => Number(a.path === "dist/index.html") - Number(b.path === "dist/index.html"));
          for (const file of prepared) {
            const target = await parent(installed, file.path, true);
            const temporary = `.gallery-sync-${randomUUID()}`;
            try {
              await stage.publish(file.staged, target.directory, temporary);
              await rename(`${target.directory.path}/${temporary}`, `${target.directory.path}/${target.name}`);
            } finally {
              try { await unlink(`${target.directory.path}/${temporary}`); }
              catch (error) { if (!isFsError(error, "ENOENT")) console.warn("[gallery-sync] Upgrade temporary cleanup failed", error); }
              await target.close();
            }
          }
          result.updated.push(app.id);
        } finally { await stage.release(); }
      } catch (error) {
        // Malformed/custom owner files are retained. Infrastructure failures are visible to startup diagnostics.
        if (error instanceof SyntaxError || isFsError(error, "ELOOP") || isFsError(error, "ENOTDIR")) result.preserved.push(app.id);
        else throw error;
      } finally { await installed?.close(); await apps?.close(); await home.close(); }
    });
  }
  return result;
}
