import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { previewPairBundleVersion } from "../../packages/contracts/src/preview-pair.js";
import { PreviewPairHostReleaseSchema, PreviewPairHostManifestSchema, PreviewPairIncrementalSchema } from "../../packages/contracts/src/preview-pair-artifact.js";
import { PreviewPairControllerReceiptSchema, type PreviewPairControllerReceipt } from "../../packages/contracts/src/preview-pair-control.js";
export async function previewFileDigest(file: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256"); let size = 0;
  if (!(await lstat(file)).isFile()) throw new Error("Preview bundle is unavailable");
  for await (const chunk of createReadStream(file)) { size += chunk.length; if (size > 3 * 1024 ** 3) throw new Error("Preview bundle is unavailable"); hash.update(chunk); }
  return { sha256: hash.digest("hex"), size };
}
async function json(file: string, maximum: number): Promise<unknown> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > maximum) throw new Error("Preview bundle is unavailable");
  return JSON.parse(await readFile(file, "utf8"));
}
/** Files come from the owned, digest-verified quarantine. Only reviewed code
 * consumes metadata; no executable, module, config hook or tar member is run. */
export async function readPreviewPairHostBundle(directory: string, raw: PreviewPairControllerReceipt) {
  try {
    const request = PreviewPairControllerReceiptSchema.parse(raw), version = previewPairBundleVersion(request.pairId, request.generation, request.sourceSha);
    const release = PreviewPairHostReleaseSchema.parse(await json(join(directory, "release.json"), 64 * 1024));
    const manifest = PreviewPairHostManifestSchema.parse(await json(join(directory, "manifest.json"), 64 * 1024));
    const incremental = PreviewPairIncrementalSchema.parse(await json(join(directory, "incremental-manifest.json"), 32 * 1024 * 1024));
    for (const record of [release, manifest]) if (record.version !== version || record.gitCommit !== request.sourceSha
      || record.gitRef !== `refs/pull/${request.pr}/head` || record.buildTime !== release.buildTime) throw new Error("Preview bundle is unavailable");
    if (incremental.version !== version || incremental.files.some(file => file.url !== `${incremental.objectRoot}/${file.sha256}`)) throw new Error("Preview bundle is unavailable");
    for (const [name, file] of [["matrix-host-bundle.tar.gz", manifest.files.bundle], ["matrix-host-bundle.tar.gz.sha256", manifest.files.checksum],
      ["incremental-manifest.json", manifest.files.incrementalManifest]] as const) {
      const actual = await previewFileDigest(join(directory, name));
      if (file.path !== `system-bundles/${version}/${name}` || file.sha256 !== actual.sha256 || file.size !== actual.size) throw new Error("Preview bundle is unavailable");
    }
    if (manifest.sha256 !== manifest.files.bundle.sha256 || manifest.bundleSha256 !== manifest.sha256
      || manifest.size !== manifest.files.bundle.size || manifest.published !== release.buildTime) throw new Error("Preview bundle is unavailable");
    return { version, sha256: manifest.sha256, size: manifest.size };
  } catch (error: unknown) {
    console.warn("[preview-pair] bundle observation unavailable", error instanceof Error ? error.name : "UnknownError");
    throw new Error("Preview bundle is unavailable");
  }
}
