import { lstat, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod/v4";
import { readBoundedJsonFileWithIdentity, type FileIdentity } from "../bounded-json-file.js";
import { writeProviderJsonAtomic } from "./provider-settings-persistence.js";
import { ProviderWorkflowError } from "./provider-workflows.js";
import { commitCodexKey, CodexKeyRollbackFailedError } from "./codex-key-transaction.js";
import { NativeProviderWriteNotStartedError } from "./native-provider-profile-guard.js";

const Credential = z.object({ version: z.literal(1), apiKey: z.string().trim().min(1).max(4096).nullable() }).strict();
const pathFor = (home: string) => join(resolve(home), "system/ai-providers/anthropic-key.json");
const missing = (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
async function assertParents(home: string, create: boolean) {
  for (const path of [join(resolve(home), "system"), join(resolve(home), "system/ai-providers")]) {
    if (create) await mkdir(path, { recursive: true, mode: 0o700 });
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()) throw new ProviderWorkflowError("unavailable");
  }
}
/** One canonical owner key. A private tombstone deliberately suppresses legacy config fallback. */
export async function readOwnerAnthropicKey(home: string): Promise<{ state: "unverified" | "setup_required" | "invalid" | "unavailable"; key?: string; identity?: FileIdentity }> {
  try {
    try { await lstat(pathFor(home)); }
    catch (error) {
      if (!missing(error)) throw error;
      const legacyPath = join(home, "system/config.json");
      try {
        const metadata = await lstat(legacyPath);
        // An inaccessible configuration source is not an invalid provider credential.
        if (metadata.isDirectory()) throw new ProviderWorkflowError("unavailable");
      } catch (legacyError) { if (missing(legacyError)) return { state: "setup_required" }; throw legacyError; }
      const legacy = await readBoundedJsonFileWithIdentity(legacyPath, 64 * 1024);
      if (!legacy) return { state: "invalid" };
      const result = z.object({ kernel: z.object({ anthropicApiKey: z.string().trim().min(1).max(4096) }).optional() }).safeParse(legacy?.value);
      const key = result.success ? result.data.kernel?.anthropicApiKey : undefined;
      return key ? { state: "unverified", key, identity: legacy!.identity } : { state: "setup_required" };
    }
    await assertParents(home, false);
    const metadata = await lstat(pathFor(home));
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) return { state: "invalid" };
    const document = await readBoundedJsonFileWithIdentity(pathFor(home), 8192);
    if (document && (document.identity.dev !== metadata.dev || document.identity.ino !== metadata.ino
      || document.identity.size !== metadata.size || document.identity.mtimeMs !== metadata.mtimeMs)) return { state: "invalid" };
    const parsed = Credential.safeParse(document?.value);
    if (!parsed.success || !document) return { state: "invalid" };
    return parsed.data.apiKey === null ? { state: "setup_required", identity: document.identity }
      : { state: "unverified", key: parsed.data.apiKey, identity: document.identity };
  } catch (error) {
    console.warn("[provider-workflow] Owner key read unavailable:", error instanceof Error ? error.name : "UnknownError");
    return { state: "unavailable" };
  }
}
export function createOwnerAnthropicKeySaver(options: { homePath: string }) {
  const save = async (apiKey: string, commit: () => Promise<void>) => {
    const directory = join(resolve(options.homePath), "system/ai-providers");
    const staging = join(directory, ".matrix-anthropic-key-staging");
    let published = false; let recovery = false; let ownsStaging = false;
    try {
      const credential = Credential.parse({ version: 1, apiKey });
      await assertParents(options.homePath, true);
      const identity = await lstat(directory);
      try { await mkdir(staging, { mode: 0o700 }); }
      catch (error) {
        if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const residue = await lstat(staging);
        if (!residue.isDirectory() || residue.isSymbolicLink() || residue.uid !== process.getuid?.() || (residue.mode & 0o777) !== 0o700) throw error;
        // Caller holds the durable profile lease; uncertain recovery cannot reach here.
        await rm(staging, { recursive: true, force: true }); await mkdir(staging, { mode: 0o700 });
      }
      ownsStaging = true;
      await writeProviderJsonAtomic(join(staging, "anthropic-key.json"), credential);
      published = true;
      await commitCodexKey({ directory, directoryIdentity: identity, staging, targetName: "anthropic-key.json", commit });
    } catch (error) {
      recovery = error instanceof CodexKeyRollbackFailedError;
      if (!published) throw new NativeProviderWriteNotStartedError();
      throw error;
    } finally {
      if (ownsStaging && !recovery) {
        try { await rm(staging, { recursive: true, force: true }); }
        catch (error) { console.warn("[provider-workflow] Owner key staging cleanup unavailable:", error instanceof Error ? error.name : "UnknownError"); }
      }
    }
  };
  return Object.assign((apiKey: string) => save(apiKey, async () => {}), { connect: save });
}
/** Called only by explicit scoped API-key sign-out; never by a discovery refresh. */
export async function revokeOwnerAnthropicKey(home: string) {
  await assertParents(home, true);
  await writeProviderJsonAtomic(pathFor(home), { version: 1, apiKey: null });
}
