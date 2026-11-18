import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod/v4";
import { OWNER_OPENAI_MODEL_IDS } from "../ai-providers/model-catalog.js";

export const CODEX_CONFIGURED_MODEL_ID = OWNER_OPENAI_MODEL_IDS[0];
const MAX_CONFIG_BYTES = 64 * 1024;
const UNAVAILABLE = "Native Codex model unavailable";
const Model = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/)
  .refine(id => id !== CODEX_CONFIGURED_MODEL_ID);
const Config = z.object({
  model: Model.optional(),
  model_provider: z.literal("openai").optional(),
  // Explicit CLI overlays are not part of the fixed personal source.
  profile: z.never().optional(),
});

/** The owner model is data, never a Codex configuration layer in the isolated process. */
export async function readHostedCodexModelIntent(codexHome: string): Promise<string | undefined> {
  const path = join(codexHome, "config.toml");
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(UNAVAILABLE);
  }
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid?.() || before.size > MAX_CONFIG_BYTES)
      throw new Error(UNAVAILABLE);
    const buffer = Buffer.alloc(before.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const after = await lstat(path);
    if (bytesRead !== before.size || after.ino !== before.ino || after.dev !== before.dev
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error(UNAVAILABLE);
    return Config.parse(parseToml(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)))).model;
  } catch (error) {
    if (!(error instanceof Error)) console.warn("[app-ai] Native Codex model read raised an unknown error");
    throw new Error(UNAVAILABLE);
  } finally { await file.close(); }
}
