/**
 * Company Brain model claims: the contract shared by the Claude client (client.ts), its prompt and skip policy
 * (prompt.ts), pricing (pricing.ts), configuration and credentials (config.ts), and the job and project service that
 * run it. Nothing here imports @anthropic-ai/sdk, so the job, the service and their tests do not depend on it.
 */
import { z } from "zod/v4";
import {
  BRAIN_EXTRACTION_LIMIT_CEILINGS, brainModelExtractorId, type BrainClaimFields, type BrainClaimModel,
  type BrainClaimModelInput, type BrainExtractionLimits,
} from "../types.js";

// Identity. The extractor id is model:<model id>/<prompt version>; changing either starts a separate claim set.

/** Models a request may name; both take the same request (adaptive thinking, effort, fallbacks "default"). */
export const BRAIN_MODEL_REQUEST_IDS = ["claude-opus-5-5", "claude-opus-5"] as const;
export type BrainModelRequestId = (typeof BRAIN_MODEL_REQUEST_IDS)[number];
export const BRAIN_MODEL_DEFAULT_ID: BrainModelRequestId = "claude-opus-5-5";
/** Bumped whenever the system prompt, the user content or the output schema changes. */
export const BRAIN_MODEL_PROMPT_VERSION = "claims-v2";
/** `model:claude-opus-5-5/claims-v2`. */
export const BRAIN_MODEL_DEFAULT_EXTRACTOR_ID =
  brainModelExtractorId(BRAIN_MODEL_DEFAULT_ID, BRAIN_MODEL_PROMPT_VERSION);

// Request.

export const BRAIN_MODEL_API_BASE_URL = "https://api.anthropic.com";
/** The beta header of the `fallbacks: "default"` form; the array form has another header and mixing them is a 400. */
export const BRAIN_MODEL_FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** Thinking counts toward max_tokens, so this bounds one call's whole output. */
export const BRAIN_MODEL_MAX_TOKENS = 8_192;
/** SDK retries per call (429, 5xx, network); the job's per-call timeout bounds the total time. */
export const BRAIN_MODEL_MAX_RETRIES = 1;
/** Claims the system prompt asks for at most; verify.ts still caps a document at BRAIN_CLAIMS_PER_DOCUMENT_MAX. */
export const BRAIN_MODEL_PROMPT_MAX_CLAIMS = 20;
export const BRAIN_MODEL_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type BrainModelEffort = (typeof BRAIN_MODEL_EFFORTS)[number];

/** One text content block; mutable so it is assignable to the SDK's text block param. */
export interface BrainModelTextBlock { type: "text"; text: string }

// Selection: a model run takes the newest pending documents first; these bodies are skipped without a call.

/** A footer-stripped body shorter than this (UTF-16 units, trimmed) is body_too_short. */
export const BRAIN_MODEL_BODY_MIN_CHARS = 200;

// Configuration: environment variables, parsed once when the provider is built.

export const BRAIN_MODEL_ENV = {
  modelId: "MATRIX_BRAIN_MODEL_ID", effort: "MATRIX_BRAIN_MODEL_EFFORT",
  documentsPerRun: "MATRIX_BRAIN_MODEL_DOCUMENTS_PER_RUN",
  costMicroUsdPerRun: "MATRIX_BRAIN_MODEL_COST_MICROUSD_PER_RUN",
  bodyMaxBytes: "MATRIX_BRAIN_MODEL_BODY_MAX_BYTES",
  spendMicroUsdPer30d: "MATRIX_BRAIN_MODEL_SPEND_MICROUSD_PER_30D",
} as const;

/**
 * bodyMaxBytes: utf8 bytes of the footer-stripped body; a larger body is skipped as document_too_large.
 * spendMicroUsdPer30d: the rolling cap per owner, across all projects, over 30 days (claims/spend.ts); default 5 USD.
 */
export interface BrainModelConfig {
  readonly modelId: BrainModelRequestId; readonly effort: BrainModelEffort; readonly documentsPerRun: number;
  readonly costMicroUsdPerRun: number; readonly bodyMaxBytes: number; readonly spendMicroUsdPer30d: number;
}

export const BRAIN_MODEL_CONFIG_DEFAULTS: BrainModelConfig = {
  modelId: BRAIN_MODEL_DEFAULT_ID, effort: "low", documentsPerRun: 20, costMicroUsdPerRun: 500_000,
  bodyMaxBytes: 32_768, spendMicroUsdPer30d: 5_000_000,
};

/** Inclusive bounds; a value outside them, or not a plain decimal integer, disables the model extractor. */
export const BRAIN_MODEL_CONFIG_BOUNDS = {
  documentsPerRun: [1, BRAIN_EXTRACTION_LIMIT_CEILINGS.documentsPerRun],
  costMicroUsdPerRun: [1, BRAIN_EXTRACTION_LIMIT_CEILINGS.costMicroUsdPerRun],
  bodyMaxBytes: [1_024, 65_536],
  spendMicroUsdPer30d: [1, BRAIN_EXTRACTION_LIMIT_CEILINGS.spendMicroUsdPer30d],
} as const satisfies Record<string, readonly [number, number]>;

/** variable: the name of the first invalid variable, never its value. */
export type BrainModelConfigResult =
  | { readonly ok: true; readonly config: BrainModelConfig }
  | { readonly ok: false; readonly variable: string };

/**
 * Fixed limits of a model run, merged with documentsPerRun, costMicroUsdPerRun and spendMicroUsdPer30d from the
 * configuration. A 120 s run
 * plus one 60 s call stays under the 5-minute run lease and Node's 300 s request timeout.
 */
export const BRAIN_MODEL_RUN_LIMITS = {
  runBudgetMs: 120_000, modelCallTimeoutMs: 60_000, tokensPerRun: 1_000_000,
} as const satisfies Partial<BrainExtractionLimits>;

// Credentials: resolved per extract request; never cached, logged, stored or returned.

/** A direct Anthropic API key. OAuth tokens (sk-ant-oat...) and Matrix proxy keys (sk-proxy-...) do not match. */
export const BRAIN_ANTHROPIC_DIRECT_KEY_PATTERN = /^sk-ant-api[A-Za-z0-9_-]+$/;
export const BRAIN_ANTHROPIC_KEY_MAX_CHARS = 4_096;

/** owner_key: kernel.anthropicApiKey in <home>/system/config.json. environment: ANTHROPIC_API_KEY, direct keys only. */
export interface BrainAnthropicCredential { readonly apiKey: string; readonly source: "owner_key" | "environment" }

export type BrainModelEnv = Readonly<Record<string, string | undefined>>;

// Output schema (structured outputs). Deliberately loose: the SDK's JSON Schema transform drops enum, length and
// pattern constraints, so verify.ts re-validates every candidate and client.ts drops unusable optional parts.

export const BrainModelWireClaimSchema = z.object({
  kind: z.string(), label: z.string().nullable(), statement: z.string(), quote: z.string(),
  fields: z.object({ assignee: z.string().nullable(), due: z.string().nullable(), severity: z.string().nullable() }),
});
export const BrainModelWireOutputSchema = z.object({ claims: z.array(BrainModelWireClaimSchema) });
export type BrainModelWireOutput = z.output<typeof BrainModelWireOutputSchema>;
