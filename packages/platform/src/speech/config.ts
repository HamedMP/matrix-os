import { z } from "zod/v4";

const IdentifierSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const ModelSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const TranscriptSchema = z.string().min(1).max(32_000);

interface SpeechAdmissionConfig {
  maximumActiveOperations: number;
  maximumActiveOperationsPerOwner: number;
  maximumAdmissionsPerOwner: number;
  admissionWindowMs: number;
}

interface SpeechLimitsConfig {
  maxBytes: number;
  maxDurationMs: number;
  maxTranscriptChars: number;
}

interface EnabledSpeechConfigBase {
  enabled: true;
  policyRevision: string;
  speechSecret: string;
  microusdPerMinute: number;
  ownerAudioEnabled: boolean;
  admission: SpeechAdmissionConfig;
  limits: SpeechLimitsConfig;
}

export type PlatformSpeechConfig = { enabled: false } | (EnabledSpeechConfigBase & ({
  provider: "openai";
  fundingMode: "existing_wallet";
  apiKey: string;
  model: string;
  allowedFundingSources: readonly ("promotional" | "addon")[];
} | {
  provider: "fixture";
  fundingMode: "fixture_no_charge";
  model: "fixture-transcribe";
  fixtureTranscript: string;
}));

export class PlatformSpeechConfigError extends Error {
  constructor() {
    super("Platform speech configuration is invalid");
    this.name = "PlatformSpeechConfigError";
  }
}

function invalid(): never {
  throw new PlatformSpeechConfigError();
}

function integer(raw: string | undefined, fallback: number | undefined, minimum: number, maximum: number): number {
  if (raw === undefined && fallback === undefined) return invalid();
  const parsed = Number(raw ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) return invalid();
  return parsed;
}

function commonConfig(env: NodeJS.ProcessEnv): Omit<EnabledSpeechConfigBase, "microusdPerMinute"> {
  const policyRevision = IdentifierSchema.safeParse(env.PLATFORM_SPEECH_POLICY_REVISION);
  const speechSecret = env.PLATFORM_SPEECH_SECRET?.trim() ?? "";
  if (!policyRevision.success || new TextEncoder().encode(speechSecret).byteLength < 32) return invalid();
  const maximumActiveOperations = integer(env.PLATFORM_SPEECH_GLOBAL_CONCURRENCY, 16, 1, 1_000);
  const maximumActiveOperationsPerOwner = integer(env.PLATFORM_SPEECH_OWNER_CONCURRENCY, 2, 1, 100);
  if (maximumActiveOperationsPerOwner > maximumActiveOperations) return invalid();
  return {
    enabled: true,
    policyRevision: policyRevision.data,
    speechSecret,
    ownerAudioEnabled: env.PLATFORM_SPEECH_OWNER_AUDIO_ENABLED !== "false",
    admission: {
      maximumActiveOperations,
      maximumActiveOperationsPerOwner,
      maximumAdmissionsPerOwner: integer(env.PLATFORM_SPEECH_OWNER_REQUESTS_PER_MINUTE, 10, 1, 10_000),
      admissionWindowMs: 60_000,
    },
    limits: {
      maxBytes: integer(env.PLATFORM_SPEECH_MAX_BYTES, 10 * 1024 * 1024, 44, 64 * 1024 * 1024),
      maxDurationMs: integer(env.PLATFORM_SPEECH_MAX_DURATION_MS, 120_000, 1_000, 60 * 60_000),
      maxTranscriptChars: integer(env.PLATFORM_SPEECH_MAX_TRANSCRIPT_CHARS, 32_000, 1, 32_000),
    },
  };
}

function fundingSources(raw: string | undefined): readonly ("promotional" | "addon")[] {
  if (!raw) return invalid();
  const values = raw.split(",").map((value) => value.trim());
  if (values.length < 1 || values.length > 2 || new Set(values).size !== values.length
    || values.some((value) => value !== "promotional" && value !== "addon")) return invalid();
  return values as ("promotional" | "addon")[];
}

export function loadPlatformSpeechConfig(env: NodeJS.ProcessEnv = process.env): PlatformSpeechConfig {
  if (env.PLATFORM_SPEECH_ENABLED !== "true") return { enabled: false };
  const provider = env.PLATFORM_SPEECH_PROVIDER;
  const common = commonConfig(env);
  if (provider === "fixture") {
    const fixtureTranscript = TranscriptSchema.safeParse(env.PLATFORM_SPEECH_FIXTURE_TRANSCRIPT);
    if (env.NODE_ENV === "production" || !fixtureTranscript.success) return invalid();
    return {
      ...common,
      provider,
      fundingMode: "fixture_no_charge",
      model: "fixture-transcribe",
      fixtureTranscript: fixtureTranscript.data,
      microusdPerMinute: 0,
    };
  }
  if (provider !== "openai") return invalid();
  const apiKey = env.PLATFORM_SPEECH_OPENAI_API_KEY?.trim() ?? "";
  const model = ModelSchema.safeParse(env.PLATFORM_SPEECH_MODEL);
  if (apiKey.length < 16 || !model.success) return invalid();
  return {
    ...common,
    provider,
    fundingMode: "existing_wallet",
    apiKey,
    model: model.data,
    microusdPerMinute: integer(env.PLATFORM_SPEECH_MICROUSD_PER_MINUTE, undefined, 1, 1_000_000_000),
    allowedFundingSources: fundingSources(env.PLATFORM_SPEECH_FUNDING_SOURCES),
  };
}
