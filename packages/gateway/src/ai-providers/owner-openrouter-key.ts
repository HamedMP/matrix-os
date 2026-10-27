import { randomUUID } from "node:crypto";
import { lstat, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod/v4";
import { readBoundedJsonFileWithIdentity, type FileIdentity } from "../bounded-json-file.js";
import { commitCodexKey, CodexKeyRollbackFailedError } from "./codex-key-transaction.js";
import { NativeProviderWriteNotStartedError } from "./native-provider-profile-guard.js";
import { writeProviderJsonAtomic } from "./provider-settings-persistence.js";
import { ProviderWorkflowError } from "./provider-workflows.js";

const Credential = z.object({
  version: z.literal(1),
  apiKey: z.string().trim().min(1).max(4096).nullable(),
  credentialGeneration: z.uuid(),
}).strict();
const pathFor = (home: string) => join(resolve(home), "system/ai-providers/openrouter-key.json");
const missing = (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";

export async function assertOwnerOpenRouterKeyParents(home: string, create: boolean): Promise<void> {
  const root = resolve(home);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()
    || rootMetadata.uid !== process.getuid?.()) throw new ProviderWorkflowError("unavailable");
  for (const path of [join(root, "system"), join(root, "system/ai-providers")]) {
    if (create) {
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (error) {
        if (!(error instanceof Error)
          || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()) {
      throw new ProviderWorkflowError("unavailable");
    }
  }
}

/** Canonical owner OpenRouter key. A null key is a private revocation tombstone. */
export async function readOwnerOpenRouterKey(home: string): Promise<{
  state: "unverified" | "setup_required" | "invalid" | "unavailable";
  key?: string;
  identity?: FileIdentity;
  credentialGeneration?: string;
}> {
  try {
    try { await lstat(pathFor(home)); }
    catch (error) {
      if (missing(error)) return { state: "setup_required" };
      throw error;
    }
    await assertOwnerOpenRouterKeyParents(home, false);
    const metadata = await lstat(pathFor(home));
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) return { state: "invalid" };
    const document = await readBoundedJsonFileWithIdentity(pathFor(home), 8192);
    if (!document || document.identity.dev !== metadata.dev || document.identity.ino !== metadata.ino
      || document.identity.size !== metadata.size || document.identity.mtimeMs !== metadata.mtimeMs) return { state: "invalid" };
    const parsed = Credential.safeParse(document.value);
    if (!parsed.success) return { state: "invalid" };
    const common = { identity: document.identity, credentialGeneration: parsed.data.credentialGeneration };
    return parsed.data.apiKey === null ? { state: "setup_required", ...common }
      : { state: "unverified", key: parsed.data.apiKey, ...common };
  } catch (error) {
    console.warn("[provider-workflow] OpenRouter key read unavailable:", error instanceof Error ? error.name : "UnknownError");
    return { state: "unavailable" };
  }
}

export function createOwnerOpenRouterKeySaver(options: {
  homePath: string;
  prepareCredentialChange?: () => Promise<() => Promise<void>>;
}) {
  const save = async (apiKey: string | null, commit: (generation: string) => Promise<void>) => {
    const directory = join(resolve(options.homePath), "system/ai-providers");
    const staging = join(directory, ".matrix-openrouter-key-staging");
    let published = false;
    let recovery = false;
    let ownsStaging = false;
    let releaseCredentialChange: (() => Promise<void>) | undefined;
    try {
      releaseCredentialChange = await options.prepareCredentialChange?.();
      const generation = randomUUID();
      const credential = Credential.parse({ version: 1, apiKey, credentialGeneration: generation });
      await assertOwnerOpenRouterKeyParents(options.homePath, true);
      const identity = await lstat(directory);
      try {
        await mkdir(staging, { mode: 0o700 });
      }
      catch (error) {
        if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const residue = await lstat(staging);
        if (!residue.isDirectory() || residue.isSymbolicLink() || residue.uid !== process.getuid?.()
          || (residue.mode & 0o777) !== 0o700) throw error;
        await rm(staging, { recursive: true, force: true });
        await mkdir(staging, { mode: 0o700 });
      }
      ownsStaging = true;
      await writeProviderJsonAtomic(join(staging, "openrouter-key.json"), credential);
      published = true;
      await commitCodexKey({
        directory,
        directoryIdentity: identity,
        staging,
        targetName: "openrouter-key.json",
        commit: () => commit(generation),
      });
    } catch (error) {
      recovery = error instanceof CodexKeyRollbackFailedError;
      if (!published) throw new NativeProviderWriteNotStartedError();
      throw error;
    } finally {
      if (ownsStaging && !recovery) {
        try {
          await rm(staging, { recursive: true, force: true });
        } catch (error) {
          console.warn("[provider-workflow] OpenRouter key staging cleanup unavailable:", error instanceof Error ? error.name : "UnknownError");
        }
      }
      await releaseCredentialChange?.();
    }
  };
  return Object.assign((apiKey: string) => save(apiKey, async () => {}), {
    connect: (apiKey: string, commit: (generation: string) => Promise<void>) => save(apiKey, commit),
    revoke: () => save(null, async () => {}),
  });
}

export async function revokeOwnerOpenRouterKey(home: string): Promise<void> {
  await createOwnerOpenRouterKeySaver({ homePath: home }).revoke();
}

