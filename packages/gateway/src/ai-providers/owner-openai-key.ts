import { lstat, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { MatrixOpenAiCredentialGenerationSchema } from "@matrix-os/contracts";
import { readBoundedJsonFileWithIdentity, type FileIdentity } from "../bounded-json-file.js";
import { writeProviderJsonAtomic } from "./provider-settings-persistence.js";
import { ProviderWorkflowError } from "./provider-workflows.js";
import { commitCodexKey, CodexKeyRollbackFailedError } from "./codex-key-transaction.js";
import { NativeProviderWriteNotStartedError } from "./native-provider-profile-guard.js";

const Credential = z.object({ version: z.literal(1), apiKey: z.string().trim().min(1).max(4096).nullable(),
  credentialGeneration: MatrixOpenAiCredentialGenerationSchema.optional() }).strict();
const pathFor = (home: string) => join(resolve(home), "system/ai-providers/openai-key.json");
const missing = (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
export async function assertOwnerOpenAiKeyParents(home: string, create: boolean) {
  for (const path of [join(resolve(home), "system"), join(resolve(home), "system/ai-providers")]) {
    if (create) await mkdir(path, { recursive: true, mode: 0o700 });
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()) throw new ProviderWorkflowError("unavailable");
  }
}
/** Explicit Matrix API key only. Native Codex, OAuth and ambient keys are never imported. */
export async function readOwnerOpenAiKey(home: string): Promise<{ state: "unverified" | "setup_required" | "invalid" | "unavailable"; key?: string; identity?: FileIdentity; credentialGeneration?: string }> {
  try {
    try { await lstat(pathFor(home)); }
    catch (error) {
      if (!missing(error)) throw error;
      return { state: "setup_required" };
    }
    await assertOwnerOpenAiKeyParents(home, false);
    const metadata = await lstat(pathFor(home));
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) return { state: "invalid" };
    const document = await readBoundedJsonFileWithIdentity(pathFor(home), 8192);
    if (document && (document.identity.dev !== metadata.dev || document.identity.ino !== metadata.ino
      || document.identity.size !== metadata.size || document.identity.mtimeMs !== metadata.mtimeMs)) return { state: "invalid" };
    const parsed = Credential.safeParse(document?.value);
    if (!parsed.success || !document) return { state: "invalid" };
    const metadataFields = { identity: document.identity, ...(parsed.data.credentialGeneration ? { credentialGeneration: parsed.data.credentialGeneration } : {}) };
    return parsed.data.apiKey === null ? { state: "setup_required", ...metadataFields }
      : { state: "unverified", key: parsed.data.apiKey, ...metadataFields };
  } catch (error) {
    console.warn("[provider-workflow] Owner key read unavailable:", error instanceof Error ? error.name : "UnknownError");
    return { state: "unavailable" };
  }
}
export function createOwnerOpenAiKeySaver(options: { homePath: string }) {
  const save = async (apiKey: string | null, commit: (generation: string) => Promise<void>) => {
    const directory = join(resolve(options.homePath), "system/ai-providers");
    const staging = join(directory, ".matrix-openai-key-staging");
    let published = false; let recovery = false; let ownsStaging = false;
    try {
      const generation = randomUUID();
      const credential = Credential.parse({ version: 1, apiKey, credentialGeneration: generation });
      await assertOwnerOpenAiKeyParents(options.homePath, true);
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
      await writeProviderJsonAtomic(join(staging, "openai-key.json"), credential);
      published = true;
      await commitCodexKey({ directory, directoryIdentity: identity, staging, targetName: "openai-key.json", commit: () => commit(generation) });
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
  return Object.assign((apiKey: string) => save(apiKey, async () => {}), {
    connect: (apiKey: string, commit: (generation: string) => Promise<void>) => save(apiKey, commit),
    revoke: () => save(null, async () => {}),
  });
}
/** Called only by explicit scoped API-key sign-out; never by a discovery refresh. */
export async function revokeOwnerOpenAiKey(home: string) {
  await createOwnerOpenAiKeySaver({ homePath: home }).revoke();
}
