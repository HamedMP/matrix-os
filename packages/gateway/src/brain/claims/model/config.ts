/**
 * Company Brain model claims: configuration from the environment, the Anthropic credential, and the provider the
 * project service calls once per model extract request. The configuration is parsed once, with no I/O; the credential
 * is read on every call and never cached, logged, stored or returned. Only direct Anthropic API keys are used: the
 * owner's key in <home>/system/config.json, else a direct ANTHROPIC_API_KEY with no relay base URL.
 */
import { join } from "node:path";
import { OwnerAnthropicKeyConfig } from "../../../ai-providers/owner-key-preflight.js";
import { readBoundedJsonFileWithIdentity } from "../../../bounded-json-file.js";
import { createAnthropicBrainClaimModel } from "./client.js";
import {
  BRAIN_MODEL_CONFIG_BOUNDS, BRAIN_MODEL_CONFIG_DEFAULTS, BRAIN_MODEL_EFFORTS, BRAIN_MODEL_ENV,
  BRAIN_MODEL_PROMPT_VERSION, BRAIN_MODEL_REQUEST_IDS, BRAIN_MODEL_RUN_LIMITS, type BrainAnthropicCredential,
  type BrainClaimModelProvider, type BrainClaimModelProviderOptions, type BrainModelConfigResult, type BrainModelEnv,
} from "./types.js";

/** The owner's config.json, as the owner key health check reads it. */
const OWNER_CONFIG_PATH = "system/config.json";
const OWNER_CONFIG_MAX_BYTES = 64 * 1024;
/** The owner key rule (trimmed, at most 4,096 characters, a direct sk-ant-api key), applied to the environment too. */
const DIRECT_KEY = OwnerAnthropicKeyConfig.shape.kernel.shape.anthropicApiKey;
/** A plain decimal integer with no sign, leading zero, exponent or fraction; bounds are checked after. */
const PLAIN_INTEGER = /^[1-9][0-9]{0,8}$/;

type IntegerKey = keyof typeof BRAIN_MODEL_CONFIG_BOUNDS;

function oneOf<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

/** Unset or blank after trim is the default. The first invalid variable, in BRAIN_MODEL_ENV order, is reported. */
export function parseBrainModelConfig(env: BrainModelEnv): BrainModelConfigResult {
  const read = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value === undefined || value === "" ? undefined : value;
  };
  const integer = (key: IntegerKey): number | null => {
    const raw = read(BRAIN_MODEL_ENV[key]);
    if (raw === undefined) return BRAIN_MODEL_CONFIG_DEFAULTS[key];
    if (!PLAIN_INTEGER.test(raw)) return null;
    const value = Number(raw);
    const [min, max] = BRAIN_MODEL_CONFIG_BOUNDS[key];
    return value >= min && value <= max ? value : null;
  };
  const modelId = read(BRAIN_MODEL_ENV.modelId) ?? BRAIN_MODEL_CONFIG_DEFAULTS.modelId;
  if (!oneOf(BRAIN_MODEL_REQUEST_IDS, modelId)) return { ok: false, variable: BRAIN_MODEL_ENV.modelId };
  const effort = read(BRAIN_MODEL_ENV.effort) ?? BRAIN_MODEL_CONFIG_DEFAULTS.effort;
  if (!oneOf(BRAIN_MODEL_EFFORTS, effort)) return { ok: false, variable: BRAIN_MODEL_ENV.effort };
  const documentsPerRun = integer("documentsPerRun");
  if (documentsPerRun === null) return { ok: false, variable: BRAIN_MODEL_ENV.documentsPerRun };
  const costMicroUsdPerRun = integer("costMicroUsdPerRun");
  if (costMicroUsdPerRun === null) return { ok: false, variable: BRAIN_MODEL_ENV.costMicroUsdPerRun };
  const bodyMaxBytes = integer("bodyMaxBytes");
  if (bodyMaxBytes === null) return { ok: false, variable: BRAIN_MODEL_ENV.bodyMaxBytes };
  const spendMicroUsdPer30d = integer("spendMicroUsdPer30d");
  if (spendMicroUsdPer30d === null) return { ok: false, variable: BRAIN_MODEL_ENV.spendMicroUsdPer30d };
  return {
    ok: true, config: { modelId, effort, documentsPerRun, costMicroUsdPerRun, bodyMaxBytes, spendMicroUsdPer30d },
  };
}

/**
 * 1. kernel.anthropicApiKey in the owner's config.json (a symlink, non-file, oversize file or bad JSON reads as
 *    absent; other file system errors reject).
 * 2. ANTHROPIC_API_KEY, only a direct key (not an OAuth token or a Matrix proxy key) and only when ANTHROPIC_BASE_URL
 *    is unset or blank, so a key meant for a relay is never sent to the API.
 * 3. null: model extraction is not configured.
 */
export async function resolveBrainAnthropicCredential(
  homePath: string, env: BrainModelEnv,
): Promise<BrainAnthropicCredential | null> {
  const document = await readBoundedJsonFileWithIdentity(join(homePath, OWNER_CONFIG_PATH), OWNER_CONFIG_MAX_BYTES);
  const owner = OwnerAnthropicKeyConfig.safeParse(document?.value);
  if (owner.success) return { apiKey: owner.data.kernel.anthropicApiKey, source: "owner_key" };
  const direct = DIRECT_KEY.safeParse(env.ANTHROPIC_API_KEY);
  if (!direct.success) return null;
  const baseUrl = env.ANTHROPIC_BASE_URL?.trim();
  if (baseUrl !== undefined && baseUrl !== "") return null;
  return { apiKey: direct.data, source: "environment" };
}

/**
 * An invalid configuration disables the model extractor (every call resolves null) and is logged once, by variable
 * name only. Otherwise each call resolves the credential and builds a client for that request alone.
 */
export function createBrainClaimModelProvider(options: BrainClaimModelProviderOptions): BrainClaimModelProvider {
  const parsed = parseBrainModelConfig(options.env);
  if (!parsed.ok) {
    console.warn("[brain-claims] model extractor disabled by an invalid setting", { variable: parsed.variable });
    return async () => null;
  }
  const { config } = parsed;
  return async () => {
    const credential = await resolveBrainAnthropicCredential(options.homePath, options.env);
    if (credential === null) return null;
    const model = createAnthropicBrainClaimModel({
      apiKey: credential.apiKey, modelId: config.modelId, effort: config.effort, bodyMaxBytes: config.bodyMaxBytes,
      timeoutMs: BRAIN_MODEL_RUN_LIMITS.modelCallTimeoutMs,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    return {
      model, modelId: config.modelId, promptVersion: BRAIN_MODEL_PROMPT_VERSION,
      limits: {
        ...BRAIN_MODEL_RUN_LIMITS, documentsPerRun: config.documentsPerRun,
        costMicroUsdPerRun: config.costMicroUsdPerRun, spendMicroUsdPer30d: config.spendMicroUsdPer30d,
      },
    };
  };
}
