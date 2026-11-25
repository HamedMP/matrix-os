import type { OwnerToolOutputProjection } from "./owner-tool-output.js";
import { createCanonicalChatEventStream, type CanonicalChatEventRepository } from "./event-stream.js";
import { createChatFailureRecorder } from "./failure-telemetry.js";
import type { ChatOwner } from "./records.js";
import type { AiCaptureFn } from "../ai-analytics.js";
import type { ChatOutboxSink } from "./outbox-delivery.js";

/** A failed sink cannot stop another sink or the committed chat stream. */
export function composeChatSinks(...sinks: (ChatOutboxSink | undefined)[]): ChatOutboxSink {
  return input => {
    for (const sink of sinks) {
      try { sink?.(input); }
      catch (error: unknown) { console.warn("[chat/sinks] Committed sink unavailable", error instanceof Error ? error.name : "UnknownError"); }
    }
  };
}

/** Gateway composition: committed events drive telemetry, never subscriber replay. */
export function createGatewayChatEventStream(options: {
  repository: CanonicalChatEventRepository;
  projectOwnerToolOutput?: OwnerToolOutputProjection;
  reconcileOwner?: (owner: ChatOwner) => Promise<unknown>;
  capture: AiCaptureFn;
  runtimeVersion?: string;
  buildSha?: string;
  onChatEvent?: import("./outbox-delivery.js").ChatOutboxSink;
}) {
  return createCanonicalChatEventStream({
    repository: options.repository,
    projectOwnerToolOutput: options.projectOwnerToolOutput,
    reconcileOwner: options.reconcileOwner,
    onCommittedEvent: composeChatSinks(createChatFailureRecorder(options), options.onChatEvent),
  });
}
