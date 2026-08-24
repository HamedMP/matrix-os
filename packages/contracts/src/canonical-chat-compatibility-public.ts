import {
  AgentThreadSnapshotSchema,
  type AgentThreadSnapshot,
} from "#agent-thread-contracts";
import {
  KernelConversationHistoryResponseSchema,
  KernelConversationSummarySchema,
  type KernelConversationHistoryResponse,
  type KernelConversationSummary,
} from "#kernel-conversations";
import {
  mapAgentThreadFromLegacyContracts,
  mapKernelConversationFromLegacyContracts,
} from "#canonical-chat-compatibility";
import type { CanonicalOwnerScope } from "#canonical-chat";
import type { CanonicalProviderDriverKind } from "#canonical-chat-provider";

export function mapKernelConversationToCanonicalChatProjection(input: {
  chatId: string;
  ownerScope: CanonicalOwnerScope;
  instanceId: string;
  model: string;
  turnId?: string;
  summary: KernelConversationSummary;
  history: KernelConversationHistoryResponse;
}) {
  return mapKernelConversationFromLegacyContracts({
    ...input,
    summary: KernelConversationSummarySchema.parse(input.summary),
    history: KernelConversationHistoryResponseSchema.parse(input.history),
  });
}

export function mapAgentThreadToCanonicalChatProjection(input: {
  chatId: string;
  ownerScope: CanonicalOwnerScope;
  instanceId: string;
  model: string;
  driverKind: CanonicalProviderDriverKind;
  turnId: string;
  runId: string;
  snapshot: AgentThreadSnapshot;
}) {
  return mapAgentThreadFromLegacyContracts({
    ...input,
    snapshot: AgentThreadSnapshotSchema.parse(input.snapshot),
  });
}
