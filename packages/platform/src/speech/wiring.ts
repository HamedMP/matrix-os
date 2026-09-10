import { createHmac, randomUUID } from "node:crypto";
import type { PlatformDB } from "../db.js";
import { createOpenAiFileTranscriptionAdapter, type FileTranscriptionAdapter } from "./adapters/openai.js";
import type { PlatformSpeechConfig } from "./config.js";
import { createAiFundedSpeechFundingPort } from "./funding.js";
import { createSpeechOperationsRepository } from "./operations.js";
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
  });
  const fingerprintSecret = deriveSecret(config.speechSecret, "fingerprint");
  if (config.provider === "fixture") {
    return createPlatformSpeechService({
      operations,
      funding: fixtureFunding(deriveSecret(config.speechSecret, "funding")),
      adapter: fixtureAdapter(config.fixtureTranscript),
      fingerprintSecret,
      policy: policy(config),
    });
  }
  return createPlatformSpeechService({
    operations,
    funding: createAiFundedSpeechFundingPort({
      allowedSources: config.allowedFundingSources,
      credentialHashSecret: deriveSecret(config.speechSecret, "funding"),
      reservationIdFactory: () => `speech_${randomUUID().replaceAll("-", "")}`,
      now: options.now,
    }),
    adapter: createOpenAiFileTranscriptionAdapter({
      apiKey: config.apiKey,
      model: config.model,
      fetchImpl: options.fetchImpl,
    }),
    fingerprintSecret,
    policy: policy(config),
  });
}
