import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod/v4";
import { assertOwnerOpenRouterKeyParents } from "../ai-providers/owner-openrouter-key.js";
import { OPENROUTER_CODEX_MODEL_IDS } from "../ai-providers/model-catalog.js";

const GenerationSchema = z.uuid();
const ModelSchema = z.enum(OPENROUTER_CODEX_MODEL_IDS);

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error)
      || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) {
    throw new Error("Selected Codex account is unavailable");
  }
}

function profileConfiguration(model: string, credentialGeneration: string): string {
  return [
    `# Matrix-managed OpenRouter profile generation ${credentialGeneration}`,
    `model = "${model}"`,
    'model_provider = "openrouter"',
    "",
    "[model_providers.openrouter]",
    'name = "OpenRouter"',
    'base_url = "https://openrouter.ai/api/v1"',
    'env_key = "OPENROUTER_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");
}

/** Build a Matrix-owned profile. It contains routing metadata only, never credentials. */
export async function prepareOpenRouterCodexProfile(input: {
  homePath: string;
  credentialGeneration: string;
  model: string;
}): Promise<string> {
  const homePath = resolve(input.homePath);
  const generation = GenerationSchema.parse(input.credentialGeneration);
  const model = ModelSchema.parse(input.model);
  await assertOwnerOpenRouterKeyParents(homePath, true);
  const profiles = join(homePath, "system/ai-providers/runtime-profiles");
  await ensurePrivateDirectory(profiles);
  const modelFingerprint = createHash("sha256").update(model).digest("hex").slice(0, 16);
  const profile = join(profiles, `codex-openrouter-${modelFingerprint}`);
  await ensurePrivateDirectory(profile);

  const target = join(profile, "config.toml");
  const staging = join(profile, `.config-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(staging, "wx", 0o600);
    await handle.writeFile(profileConfiguration(model, generation), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(staging, target);
  } finally {
    await handle?.close();
    await rm(staging, { force: true }).catch((error: unknown) => {
      console.warn(
        "[coding-agents] OpenRouter Codex profile cleanup unavailable:",
        error instanceof Error ? error.name : "UnknownError",
      );
    });
  }
  return profile;
}
