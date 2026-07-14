import type {
  AgentMessagingSelection,
  AgentProviderDescriptor,
  AgentRuntimeDescriptor,
  AgentRuntimeId,
} from "@matrix-os/contracts";

export interface RuntimeConfigureInput {
  provider: string;
  model: string;
  baseUrl?: string;
  expectedConfigRevision?: string;
}

export interface MessagingRuntimeAdapter {
  readonly id: AgentRuntimeId;
  probe(signal: AbortSignal): Promise<AgentRuntimeDescriptor>;
  catalog(signal: AbortSignal): Promise<AgentProviderDescriptor[]>;
  selection(signal: AbortSignal): Promise<AgentMessagingSelection>;
  configure(
    input: RuntimeConfigureInput,
    signal: AbortSignal,
  ): Promise<AgentMessagingSelection>;
  prepare(signal: AbortSignal): Promise<void>;
  activate(signal: AbortSignal): Promise<void>;
  deactivate(signal: AbortSignal): Promise<void>;
  dashboard(signal: AbortSignal): Promise<Record<string, unknown> | null>;
  close(): Promise<void>;
}
