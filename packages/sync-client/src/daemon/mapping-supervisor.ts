import type { SyncMappingConfig } from "@matrix-os/contracts/sync";
import { syncMappingStatePath } from "../lib/sync-mapping-config.js";
import {
  MappingSession,
  type MappingSessionOptions,
  type ScopeRevision,
} from "./mapping-session.js";
import type { GatewayClient } from "./r2-client.js";
import type { ManifestEntry, SyncChangeEvent } from "./types.js";

export interface MappingSessionLike {
  mapping: { id: string };
  start: (remoteFiles: Record<string, ManifestEntry>) => Promise<void>;
  stop: () => Promise<void>;
  applyRemoteEvent: (event: SyncChangeEvent) => Promise<boolean>;
}

export async function openMappingSessions<T extends MappingSessionLike = MappingSession>(input: {
  configDir: string;
  config: SyncMappingConfig;
  gatewayClient: GatewayClient;
  revision: ScopeRevision;
  logger: MappingSessionOptions["logger"];
  enqueue: MappingSessionOptions["enqueue"];
  onAuthRejected: MappingSessionOptions["onAuthRejected"];
  open?: (options: MappingSessionOptions) => Promise<T>;
}): Promise<T[]> {
  const open = input.open ?? (MappingSession.open as unknown as (
    options: MappingSessionOptions,
  ) => Promise<T>);
  return Promise.all(input.config.mappings.map((mapping) => open({
    mapping,
    stateFile: syncMappingStatePath(input.configDir, input.config, mapping.id),
    gatewayClient: input.gatewayClient,
    revision: input.revision,
    logger: input.logger,
    enqueue: input.enqueue,
    onAuthRejected: input.onAuthRejected,
  })));
}

export async function startMappingSessions(
  sessions: MappingSessionLike[],
  remoteFiles: Record<string, ManifestEntry>,
): Promise<void> {
  for (const session of sessions) await session.start(remoteFiles);
}

export async function dispatchMappingEvent(
  sessions: MappingSessionLike[],
  event: SyncChangeEvent,
): Promise<boolean> {
  let complete = true;
  for (const session of sessions) {
    complete = await session.applyRemoteEvent(event) && complete;
  }
  return complete;
}

export async function stopMappingSessions(sessions: MappingSessionLike[]): Promise<void> {
  await Promise.all(sessions.map((session) => session.stop()));
}
