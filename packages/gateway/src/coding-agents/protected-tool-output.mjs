import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, link, unlink, lstat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";

// Runtime-owned configuration, not an application data store. Tool ciphertext
// lives in the existing journal/Postgres lifecycle and is deleted with its Chat.
const Envelope = z.object({
  version: z.literal(1),
  iv: z.string().length(16).regex(/^[A-Za-z0-9+/]+$/),
  tag: z.string().length(24).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  data: z.string().min(4).max(22_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict();

/** @param {string} home */
export async function loadToolOutputKey(home) {
  const directory = join(home, "system");
  await mkdir(directory, { recursive: true });
  if (!(await lstat(directory)).isDirectory()) throw new Error("Invalid tool output key directory");
  const path = join(directory, ".tool-output.key");
  async function read() {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== 32 || (info.mode & 0o077) !== 0
        || (process.getuid && info.uid !== process.getuid())) throw new Error("Invalid tool output key");
      return await handle.readFile();
    } finally { await handle.close(); }
  }
  try { return await read(); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  // Publish a completely written key atomically. Never overwrite another
  // initializer's key or expose a partially written file to readers.
  const temporary = join(directory, `.tool-output-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(randomBytes(32));
    await handle.sync();
    try { await link(temporary, path); }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
  } finally { await handle.close(); await unlink(temporary); }
  return read();
}

/** @param {Buffer} key @param {string} toolCallId @param {string} text */
export function sealToolOutput(key, toolCallId, text) {
  if (key.length !== 32 || !toolCallId || text.length > 4000 || Buffer.byteLength(text) > 16 * 1024) throw new Error("Invalid tool output");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`matrix-tool-output:v1:${toolCallId}`));
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return { version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

/** @param {Buffer} key @param {string} toolCallId @param {unknown} envelope */
export function openToolOutput(key, toolCallId, envelope) {
  const value = Envelope.parse(envelope);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
  decipher.setAAD(Buffer.from(`matrix-tool-output:v1:${toolCallId}`));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  const result = Buffer.concat([decipher.update(Buffer.from(value.data, "base64")), decipher.final()]);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(result);
  if (text.length > 4000 || result.length > 16 * 1024) throw new Error("Invalid tool output");
  return text;
}
