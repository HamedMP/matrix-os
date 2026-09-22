import type { CodingAgentProviderEvent } from "@matrix-os/contracts";

type Metadata = { id: string; parent: string; turn: string };
type Request = (method: string, params: unknown, timeoutMs?: number, metadata?: Metadata) => Promise<unknown>;

export function createCodexSubagentRuntime(options: {
  persist(event: CodingAgentProviderEvent): Promise<void>;
  progress(id: string): void;
  warn(error: unknown): void;
}): {
  reset(): void;
  project(raw: unknown, parent: string | undefined, turn: string | undefined): Promise<void>;
  projectMetadata(metadata: Metadata, thread: unknown): Promise<void>;
  dispatchMetadata(options: {
    availableRequests(): number;
    parent: string | undefined;
    turn: string | undefined;
    request: Request;
  }): void;
  isChildMessage(raw: unknown, parent: string | undefined): boolean;
};
