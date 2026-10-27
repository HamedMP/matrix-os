import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";

const MAX_FILE_BYTES = 1024 * 1024;
const Model = z.enum(["openai/gpt-5.6-luna", "openai/gpt-5.6-sol"]);
const Binding = z.object({
  harnessInstanceId: z.string().min(1).max(128),
  accountId: z.string().min(1).max(128),
  configurationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const Credential = z.object({
  version: z.literal(1),
  apiKey: z.string().trim().min(1).max(4096),
  credentialGeneration: z.uuid(),
}).strict();

async function readPrivateJson(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.getuid?.()
      || (metadata.mode & 0o077) !== 0 || metadata.size > MAX_FILE_BYTES) {
      throw new Error("openrouter_codex_unavailable");
    }
    const bytes = Buffer.alloc(Number(metadata.size) + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== metadata.size) throw new Error("openrouter_codex_unavailable");
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await file.close();
  }
}

async function assertSavedBinding(expectedGeneration, expectedModel, binding, environment) {
  const credential = Credential.parse(await readPrivateJson(
    join(environment.HOME, "system/ai-providers/openrouter-key.json"),
  ));
  if (credential.credentialGeneration !== expectedGeneration
    || credential.apiKey !== environment.OPENROUTER_API_KEY) {
    throw new Error("openrouter_codex_unavailable");
  }
  const settings = await readPrivateJson(join(environment.HOME, "system/ai-providers/settings.json"));
  if (!Array.isArray(settings?.harnesses) || settings.harnesses.length > 128) {
    throw new Error("openrouter_codex_unavailable");
  }
  const rows = settings.harnesses.filter((row) => row?.harness === "codex");
  const row = rows[0];
  const fingerprint = createHash("sha256").update(JSON.stringify({
    credentialGeneration: expectedGeneration,
    model: expectedModel,
  })).digest("hex");
  if (rows.length !== 1 || !row || row.id !== binding.harnessInstanceId
    || row.enabled !== true || row.accessSourceId !== "owner_openrouter"
    || row.selectedAccountId !== binding.accountId
    || row.credentialGeneration !== expectedGeneration
    || row.route?.kind !== "fixed" || row.route.providerId !== "openrouter"
    || row.route.modelId !== expectedModel
    || binding.configurationFingerprint !== fingerprint) {
    throw new Error("openrouter_codex_unavailable");
  }
}

/** Reacquire the file-backed generation and the effective Codex provider before every admitted turn. */
export async function createOpenRouterCodexExecutionProof(
  expectedGeneration,
  expectedModel,
  rawBinding,
  environment,
) {
  if (!environment.HOME || !environment.CODEX_HOME || !environment.OPENROUTER_API_KEY) {
    throw new Error("openrouter_codex_unavailable");
  }
  const generation = z.uuid().parse(expectedGeneration);
  const model = Model.parse(expectedModel);
  const binding = Binding.parse(rawBinding);
  await assertSavedBinding(generation, model, binding, environment);
  return async (request) => {
    await assertSavedBinding(generation, model, binding, environment);
    const { config } = await request("config/read", { includeLayers: false, cwd: process.cwd() });
    if (!config || config.model_provider !== "openrouter" || config.model !== model) {
      throw new Error("openrouter_codex_unavailable");
    }
    await assertSavedBinding(generation, model, binding, environment);
  };
}

export function assertOpenRouterCodexThreadProvider(started) {
  if (started?.modelProvider !== "openrouter") throw new Error("openrouter_codex_unavailable");
}
