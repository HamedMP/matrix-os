import type { OwnerToolOutputProjection } from "./owner-tool-output.js";
import { createCanonicalChatEventStream, type CanonicalChatEventRepository } from "./event-stream.js";
import { createChatFailureRecorder } from "./failure-telemetry.js";
import type { ChatOwner } from "./records.js";
import type { AiCaptureFn } from "../ai-analytics.js";

/** Gateway composition: committed events drive telemetry, never subscriber replay. */
export function createGatewayChatEventStream(options: {
  repository: CanonicalChatEventRepository;
  projectOwnerToolOutput?: OwnerToolOutputProjection;
  reconcileOwner?: (owner: ChatOwner) => Promise<unknown>;
  capture: AiCaptureFn;
  runtimeVersion?: string;
  buildSha?: string;
}) {
  return createCanonicalChatEventStream({
    repository: options.repository,
    projectOwnerToolOutput: options.projectOwnerToolOutput,
    reconcileOwner: options.reconcileOwner,
    onCommittedEvent: createChatFailureRecorder(options),
  });
}
