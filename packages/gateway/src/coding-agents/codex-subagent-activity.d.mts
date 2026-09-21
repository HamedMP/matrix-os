import type { ChatSubagent } from "@matrix-os/contracts";
export function createCodexSubagentActivity(options?: { maxAgents?: number }): {
  readonly size: number;
  reset(): void;
  project(raw: unknown, parent: string | undefined, turn: string | undefined): Array<{
    type: "matrix.codex.subagent.activity";
    activityId: string;
    subagent: ChatSubagent;
  }>;
};
