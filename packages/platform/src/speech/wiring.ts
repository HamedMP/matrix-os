import { createHmac, randomUUID } from "node:crypto";
import type { PlatformDB } from "../db.js";
import {
  createOpenAiFileTranscriptionAdapter,
  createOpenAiSpeechSynthesisAdapter,
  type FileTranscriptionAdapter,
  type SpeechSynthesisAdapter,
} from "./adapters/openai.js";
import type { PlatformSpeechConfig } from "./config.js";
import { createAiFundedSpeechFundingPort } from "./funding.js";
import { createSpeechOperationsRepository } from "./operations.js";
import { reconcileSpeechMonthlyAllowances } from "./allowance.js";
import {
  createPlatformSpeechService,
  createUnavailablePlatformSpeechService,
  type PlatformSpeechPolicy,
  type PlatformSpeechService,
  type SpeechFundingPort,
} from "./service.js";

const DISABLED_LIMITS = {
  enabled: true as const,
  maxBytes: 10 * 1024 * 1024,
  maxDurationMs: 120_000,
  maxTranscriptChars: 32_000,
  supportedMediaTypes: ["audio/wav"] as const,
  languageHints: false,
};

function deriveSecret(secret: string, purpose: "fingerprint" | "funding"): string {
  return createHmac("sha256", secret).update(`matrix-platform-speech:${purpose}`).digest("hex");
}

function policy(config: Exclude<PlatformSpeechConfig, { enabled: false }>): PlatformSpeechPolicy {
  const source = {
    enabled: true as const,
    ...config.limits,
    supportedMediaTypes: ["audio/wav"] as const,
    languageHints: false,
  };
  return {
    enabled: true,
    revision: config.policyRevision,
    modelId: config.model,
    microusdPerMinute: config.microusdPerMinute,
    dictation: source,
    ownerAudio: config.ownerAudioEnabled ? { ...source } : { enabled: false },
    synthesis: {
      enabled: true,
      modelId: config.synthesisModel,
      microusdPerMinute: config.synthesisMicrousdPerMinute,
      maxInputChars: 4_096,
      maxDurationMs: 10 * 60_000,
    },
  };
}

function fixtureFunding(secret: string): SpeechFundingPort {
  return {
    async reserve(_trx, input) {
      const suffix = createHmac("sha256", secret).update([
        input.identity.ownerId,
        input.identity.machineId,
        input.identity.runtimeSlot,
        input.requestId,
        input.policyRevision,
        input.modelId,
      ].join("\0")).digest("hex").slice(0, 48);
      return { reservationId: `fixture_${suffix}`, reservedMicrousd: 0 };
    },
    async start() {},
    async settle() {},
    async release() {},
  };
}

function fixtureAdapter(transcript: string): FileTranscriptionAdapter {
  return {
    id: "fixture-file",
    async transcribe(input) {
      if (input.signal.aborted) throw new DOMException("Aborted", "AbortError");
      return { text: transcript };
    },
  };
}

function fixtureSynthesisAdapter(): SpeechSynthesisAdapter {
  return {
    id: "fixture-speech",
    async synthesize(input) {
      if (input.signal.aborted) throw new DOMException("Aborted", "AbortError");
      return new Uint8Array(4_800);
    },
  };
}

export function createConfiguredPlatformSpeechService(options: {
  db: PlatformDB;
  config: PlatformSpeechConfig;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): PlatformSpeechService {
  if (!options.config.enabled) {
    return createUnavailablePlatformSpeechService({
      dictation: DISABLED_LIMITS,
      ownerAudio: { enabled: false },
    });
  }
  const config = options.config;
  const operations = createSpeechOperationsRepository({
    db: options.db,
    now: options.now,
    ...config.admission,
    ...(config.provider === "openai" && config.fundingMode === "preview_no_charge" ? {
      maximumAdmissionsPerRuntimeLifetime: config.previewMaximumOperationsPerRuntime,
      admissionsNotAfter: new Date(config.previewNotAfter),
    } : {}),
  });
  const fingerprintSecret = deriveSecret(config.speechSecret, "fingerprint");
  if (config.provider === "fixture") {
    const funding = fixtureFunding(deriveSecret(config.speechSecret, "funding"));
    return createPlatformSpeechService({
      operations,
      funding,
      adapter: fixtureAdapter(config.fixtureTranscript),
      synthesisAdapter: fixtureSynthesisAdapter(),
      fingerprintSecret,
      policy: policy(config),
    });
  }
  const funding = config.fundingMode === "preview_no_charge"
    ? fixtureFunding(deriveSecret(config.speechSecret, "funding"))
    : createAiFundedSpeechFundingPort({
      allowedSources: config.allowedFundingSources,
      credentialHashSecret: deriveSecret(config.speechSecret, "funding"),
      reservationIdFactory: () => `speech_${randomUUID().replaceAll("-", "")}`,
      now: options.now,
      monthlyAllowance: {
        monthlyBudgetMicrousd: config.monthlyBudgetMicrousd,
        monthlyPromotionalCreditMicrousd: config.monthlyPromotionalCreditMicrousd,
      },
    });
  const service = createPlatformSpeechService({
    operations,
    funding,
    adapter: createOpenAiFileTranscriptionAdapter({
      apiKey: config.apiKey,
      model: config.model,
      fetchImpl: options.fetchImpl,
    }),
    synthesisAdapter: createOpenAiSpeechSynthesisAdapter({
      apiKey: config.apiKey,
      model: config.synthesisModel,
      voice: config.synthesisVoice,
      fetchImpl: options.fetchImpl,
    }),
    fingerprintSecret,
    policy: policy(config),
  });
  if (config.fundingMode !== "existing_wallet") return service;
  let reconciliation: Promise<void> | undefined;
  const reconcile = () => {
    if (reconciliation) return;
    reconciliation = reconcileSpeechMonthlyAllowances({
      db: options.db,
      monthlyBudgetMicrousd: config.monthlyBudgetMicrousd,
      monthlyPromotionalCreditMicrousd: config.monthlyPromotionalCreditMicrousd,
      now: options.now,
    }).then(() => undefined).catch((error: unknown) => {
      console.warn("[platform-speech] monthly allowance sweep failed", error instanceof Error ? error.name : "UnknownError");
    }).finally(() => {
      reconciliation = undefined;
    });
  };
  reconcile();
  const timer = setInterval(reconcile, 6 * 60 * 60_000);
  timer.unref?.();
  return {
    ...service,
    async shutdown() {
      clearInterval(timer);
      await reconciliation;
      await service.shutdown();
    },
  };
}
