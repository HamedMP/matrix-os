import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceSession } from "./domains/sessions/agent-session-manager.js";

/** Only derived OS-owned paths are removed; persisted transcriptPath is never trusted. */
export async function deleteProjectSessionFiles(homePath: string, session: WorkspaceSession): Promise<void> {
  for (const path of [
    join(homePath, "system", "session-output", `${session.id}.jsonl`),
    join(homePath, "system", "coding-agents", "provider-events", `${session.id}.jsonl`),
    join(homePath, "system", "sessions", `${session.id}.json`),
  ]) {
    await unlink(path).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
  }
}
