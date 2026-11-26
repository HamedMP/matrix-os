import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { extname, join, relative } from "node:path";

export const MAX_CAPTURED_ARTIFACT_BYTES = 10 * 1024 * 1024;

/**
 * Reads a provider-named file once its real path passes `isAllowed`. The
 * provider controls the path, so the opened descriptor is bound to the checked
 * identity and a file that changes while being read is refused.
 *
 * @param {string} path
 * @param {(resolvedPath: string) => Promise<boolean>} isAllowed
 * @returns {Promise<Buffer>}
 */
export async function readCodexArtifactFile(path, isAllowed) {
  let source;
  try {
    const resolved = await realpath(path);
    if (!await isAllowed(resolved)) throw new Error("Codex artifact file is outside the run roots");
    source = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await source.stat({ bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(MAX_CAPTURED_ARTIFACT_BYTES)) {
      throw new Error("Codex artifact file is unavailable");
    }
    // A parent directory can change after realpath.
    const openedPath = await realpath(path);
    const current = await lstat(openedPath, { bigint: true });
    if (!await isAllowed(openedPath) || before.dev !== current.dev || before.ino !== current.ino) {
      throw new Error("Codex artifact file changed while being opened");
    }
    const bytes = await source.readFile();
    const after = await source.stat({ bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw new Error("Codex artifact file changed while being captured");
    }
    return bytes;
  } finally {
    await source?.close();
  }
}

/**
 * Stores captured bytes content-addressed under the owner's home, so Chat
 * keeps the artifact even after the provider removes its own copy.
 *
 * @param {{ homePath: string, bytes: Buffer, label: string }} input
 * @returns {Promise<{ ownerReference: string, sha256: string, sizeBytes: number }>}
 */
export async function storeCodexArtifactBytes({ homePath, bytes, label }) {
  if (bytes.length === 0 || bytes.length > MAX_CAPTURED_ARTIFACT_BYTES) {
    throw new Error("Codex artifact bytes exceed the capture limit");
  }
  const rawExtension = extname(label).toLowerCase();
  const extension = /^\.[a-z0-9]{1,10}$/.test(rawExtension) ? rawExtension : ".bin";
  const digest = createHash("sha256").update(bytes).digest("hex");
  const directory = join(homePath, "data", "chat-artifacts", "codex", "sha256");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${digest}${extension}`);
  let capturedExists = false;
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size !== bytes.length) {
      throw new Error("Codex artifact capture path is unsafe");
    }
    capturedExists = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  let handle;
  let created = false;
  try {
    if (!capturedExists) {
      handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      created = true;
      await handle.writeFile(bytes);
      await handle.sync();
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size !== bytes.length) {
      throw new Error("Codex artifact capture collision");
    }
  } finally {
    await handle?.close();
    if (created) await chmod(path, 0o600);
  }
  return {
    ownerReference: relative(homePath, path).split("\\").join("/"),
    sha256: digest,
    sizeBytes: bytes.length,
  };
}

/** Stable per session, item, output and content, so a replay never duplicates. */
export function codexArtifactAttachmentId({ sessionId, providerItemId, outputIndex, sha256 }) {
  return `attachment_codex_${createHash("sha256")
    .update(`${sessionId}\0${providerItemId}\0${outputIndex}\0${sha256}`)
    .digest("hex").slice(0, 32)}`;
}
