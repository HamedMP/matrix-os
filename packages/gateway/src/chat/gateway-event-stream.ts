import { createCanonicalChatEventStream, type CanonicalChatEventRepository } from "./event-stream.js";
import { createChatFailureRecorder } from "./failure-telemetry.js";
import type { ChatOwner } from "./records.js";
import type { AiCaptureFn } from "../ai-analytics.js";

/** Gateway composition: committed events drive telemetry, never subscriber replay. */
export function createGatewayChatEventStream(options: {
  repository: CanonicalChatEventRepository;
  reconcileOwner?: (owner: ChatOwner) => Promise<unknown>;
  capture: AiCaptureFn;
  runtimeVersion?: string;
  buildSha?: string;
}) {
  return createCanonicalChatEventStream({
    repository: options.repository,
    reconcileOwner: options.reconcileOwner,
    onCommittedEvent: createChatFailureRecorder(options),
  });
}
