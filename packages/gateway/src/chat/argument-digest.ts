import { createHash } from "node:crypto";
import type {
  CanonicalChatArgumentDigest,
  CanonicalChatCancellationCapability,
  CanonicalChatCancellationGranularity,
  CanonicalChatRunPolicy,
} from "@matrix-os/contracts";
import { chatContextRequestHash } from "./agent-context.js";
import type { CanonicalChatProviderAdapter } from "./provider-adapter.js";

/**
 * Deterministic JSON with recursively sorted object keys (I-JSON style).
 * Two semantically identical argument payloads always produce the same
 * string, so digests compare the action, not the serialisation.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJsonStringify(entry)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJsonStringify(entry)}`).join(",")}}`;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * SHA-256 over the canonical serialisation of a normalized argument payload.
 * Approvals bind to this exact digest; an adapter or host may only execute
 * the action when the digest of the submitted arguments matches.
 */
export function normalizedArgumentDigest(argumentsPayload: unknown): CanonicalChatArgumentDigest {
  return sha256Hex(canonicalJsonStringify(argumentsPayload)) as CanonicalChatArgumentDigest;
}

/**
 * Canonical request hash for turn admission. The immutable run policy is
 * folded in so a replayed clientRequestId with a different policy conflicts
 * instead of silently adopting the earlier admission. Policy-less turns keep
 * the pre-existing digest so replays across a deploy boundary still dedupe.
 */
export function chatRequestHash(
  input: Parameters<typeof chatContextRequestHash>[0],
  runPolicy: CanonicalChatRunPolicy | undefined,
): string {
  const base = chatContextRequestHash(input);
  if (runPolicy === undefined) return base;
  return sha256Hex(`${base}\npolicy\n${canonicalJsonStringify(runPolicy)}`);
}

/**
 * TRUTH IN TELEMETRY: the catalog may claim a cancellation granularity, but
 * the run snapshot can only promise what the loaded adapter can honour.
 * AbortController gives every non-detached adapter a guaranteed run-level
 * abort; detached adapters need the provider cancel hook, and tool-level
 * cancellation additionally needs a per-tool hook. Claims without the
 * required hook degrade to the strongest honest granularity.
 */
export function truthfulCancellationGranularity(
  declared: CanonicalChatCancellationCapability | undefined,
  adapter?: Pick<CanonicalChatProviderAdapter, "cancel" | "cancelTool" | "detachOnShutdown">,
): CanonicalChatCancellationGranularity {
  const granularity: CanonicalChatCancellationGranularity = declared === true
    ? "run"
    : declared === false || declared === undefined
      ? "none"
      : declared;
  if (granularity === "none") return "none";
  const runCancel = adapter?.detachOnShutdown ? adapter.cancel !== undefined : true;
  if (!runCancel) return "none";
  if (granularity === "tool" && adapter?.cancelTool === undefined) return "run";
  return granularity;
}
