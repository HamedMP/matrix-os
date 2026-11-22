import type { AiProviderSnapshotV3 } from "@matrix-os/contracts";

/** Exact platform truth for Matrix AI models that must use the OpenAI-compatible Bedrock relay. */
export function isEffectiveBedrockModel(
  snapshot: Pick<AiProviderSnapshotV3, "upstreamPreference">,
  accessSourceId: string,
  modelId: string,
): boolean {
  if (accessSourceId !== "matrix_included"
    || snapshot.upstreamPreference?.effectiveUpstream !== "aws_bedrock") return false;
  return (snapshot.upstreamPreference.effectiveBedrockModelIds ?? [])
    .some((candidate) => candidate.replace(/^anthropic\//, "") === modelId);
}
