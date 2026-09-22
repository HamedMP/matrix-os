import type { ChatSubagent } from "@matrix-os/contracts";
export function createCodexSubagentActivity(options?: { maxAgents?: number }): {
  readonly size: number;
  reset(): void;
  takeMetadataRequests(): string[];
  projectMetadata(id: string, thread: unknown, parent: string, turn: string): Array<{
    type: "matrix.codex.subagent.activity"; activityId: string; subagent: ChatSubagent;
  }>;
  project(raw: unknown, parent: string | undefined, turn: string | undefined): Array<{
    type: "matrix.codex.subagent.activity";
    activityId: string;
    subagent: ChatSubagent;
  }>;
};
