import {
  AiProviderSnapshotV3Schema,
  type AiProviderSnapshotV3,
} from "@matrix-os/contracts";
import { getGatewayUrl } from "./gateway";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const READ_TIMEOUT_MS = 10_000;
const SAFE_ERROR_MAX = 64;

type Fetcher = typeof fetch;

export interface ReadyAiModelChoice {
  instanceId: string;
  accessSourceId: string;
  accessSourceLabel: string;
  fundingLabel: string;
  modelId: string;
  modelLabel: string;
  effortControls: AiProviderSnapshotV3["models"][number]["effortControls"];
}

export class AiProviderClientError extends Error {
  constructor(
    readonly kind: "invalid_response" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "AiProviderClientError";
  }
}

const SAFE_ERRORS: Record<string, string> = {
  provider_status_unavailable: "AI provider status is temporarily unavailable.",
};

export function safeAiProviderError(value: unknown): string {
  return typeof value === "string" && value.length <= SAFE_ERROR_MAX
    ? SAFE_ERRORS[value] ?? "AI provider status is unavailable."
    : "AI provider status is unavailable.";
}

export function normalizeAiProviderSnapshot(value: unknown): AiProviderSnapshotV3 {
  const parsed = AiProviderSnapshotV3Schema.safeParse(value);
  if (!parsed.success) {
    throw new AiProviderClientError("invalid_response", "AI provider status is unavailable.");
  }
  return parsed.data;
}

export function deriveReadyModelChoices(
  snapshot: AiProviderSnapshotV3,
): ReadyAiModelChoice[] {
  const sources = new Map(snapshot.accessSources.map((source) => [source.id, source]));
  const models = new Map(snapshot.models.map((model) => [model.id, model]));
  return snapshot.instances.flatMap((instance) => {
    if (instance.readiness.state !== "ready") return [];
    const source = sources.get(instance.accessSourceId);
    if (!source || source.state !== "ready") return [];
    return instance.modelIds.flatMap((modelId) => {
      const model = models.get(modelId);
      if (!model || model.status === "retired" || model.status === "unavailable") return [];
      return [{
        instanceId: instance.id,
        accessSourceId: source.id,
        accessSourceLabel: source.displayName,
        fundingLabel: source.fundingKind === "matrix_included"
          ? "Included"
          : source.fundingKind === "matrix_addon"
            ? "Matrix add-on"
            : "Owner-funded",
        modelId: model.id,
        modelLabel: model.displayName,
        effortControls: model.effortControls,
      }];
    });
  });
}

async function boundedJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new AiProviderClientError("invalid_response", "AI provider status is unavailable.");
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      console.warn(
        "AI provider response parsing failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
    }
    throw new AiProviderClientError("invalid_response", "AI provider status is unavailable.");
  }
}

export async function loadAiProviderSnapshot(options: {
  fetcher?: Fetcher;
  refresh?: boolean;
} = {}): Promise<AiProviderSnapshotV3> {
  const fetcher = options.fetcher ?? fetch;
  const suffix = options.refresh ? "?refresh=true" : "";
  let response: Response;
  try {
    response = await fetcher(`${getGatewayUrl()}/api/ai/providers${suffix}`, {
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch (_error) {
    throw new AiProviderClientError("unavailable", "AI provider status is unavailable.");
  }
  if (!response.ok) {
    throw new AiProviderClientError("unavailable", "AI provider status is unavailable.");
  }
  return normalizeAiProviderSnapshot(await boundedJson(response));
}
