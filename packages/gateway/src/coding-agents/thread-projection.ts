import type { AgentThreadSummary } from "@matrix-os/contracts";

export type CodingAgentThreadProjectionChange = {
  type: "created" | "updated" | "removed";
  thread: AgentThreadSummary;
};

export type CodingAgentThreadProjectionPublisher = (
  change: CodingAgentThreadProjectionChange,
) => Promise<void>;

export function deriveThreadProjectionChanges<T extends { id: string }>(options: {
  previous: readonly T[];
  next: readonly T[];
  toSummary(thread: T): AgentThreadSummary;
}): CodingAgentThreadProjectionChange[] {
  const changes: CodingAgentThreadProjectionChange[] = [];
  for (const thread of options.next) {
    const previousThread = options.previous.find((candidate) => candidate.id === thread.id);
    if (!previousThread) {
      changes.push({ type: "created", thread: options.toSummary(thread) });
    // The caller must preserve object identity for unchanged records. This also
    // publishes mutations to server-only fields whose public summary is stable.
    } else if (previousThread !== thread) {
      changes.push({ type: "updated", thread: options.toSummary(thread) });
    }
  }
  for (const thread of options.previous) {
    if (!options.next.some((candidate) => candidate.id === thread.id)) {
      changes.push({ type: "removed", thread: options.toSummary(thread) });
    }
  }
  return changes;
}

export async function publishThreadProjectionChanges(options: {
  changes: readonly CodingAgentThreadProjectionChange[];
  publisher?: CodingAgentThreadProjectionPublisher;
  logFailure(err: unknown): void;
}): Promise<void> {
  if (!options.publisher) return;
  for (const change of options.changes) {
    if (!change.thread.projectId) continue;
    try {
      await options.publisher(change);
    } catch (err: unknown) {
      options.logFailure(err);
    }
  }
}
