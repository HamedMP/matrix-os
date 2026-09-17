import { z } from "zod/v4";
import { createZellijAdapter, type ZellijAdapter } from "./shell/zellij.js";

export type LegacySessionRuntime = Pick<ZellijAdapter, "deleteSession">;
// Older releases used the persisted sess_<UUID> directly as the Zellij name.
const LegacySessionName = z.string().regex(
  /^(?:matrix-[A-Za-z0-9_-]{1,128}|sess_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
);

/** Retired session records have a Zellij name, not a shared-workspace tab ref. */
export async function stopLegacySession(name: unknown, runtime?: LegacySessionRuntime): Promise<void> {
  const sessionName = LegacySessionName.parse(name);
  // The adapter confirms absence after a failed delete; transport/binary failures
  // remain errors. Bound both commands within the provider's five-second stop.
  const adapter = runtime ?? createZellijAdapter({ timeoutMs: 2_000, manageConfig: false });
  await adapter.deleteSession(sessionName, { force: true });
}
