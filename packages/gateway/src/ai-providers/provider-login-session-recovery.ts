import { createHash } from "node:crypto";
import type { AgentKind } from "../shell/agent-session-state.js";
import type { ShellAgentLiveness } from "../shell/registry.js";
import { ProviderSettingsStoreError } from "./provider-settings-errors.js";

export interface ProviderLoginRegistry {
  create(input: { name: string; cwd?: string; cmd?: string; agent?: AgentKind; exclusive?: boolean }): Promise<{ name: string }>;
  get(name: string): Promise<{ name: string }>;
  delete(name: string, options?: { force?: boolean }): Promise<void>;
  rename(name: string, nextName: string): Promise<{ name: string }>;
  observeAgentLiveness(name: string, agent: AgentKind): Promise<ShellAgentLiveness>;
  archiveStopped?(name: string, nextName: string, agent: AgentKind): Promise<{ name: string }>;
}

/** Preserve ended panes; never terminate an existing login or owner command. */
export async function recoverProviderLoginSession(
  registry: ProviderLoginRegistry,
  name: string,
  agent: AgentKind,
  archiveKey: string,
  beforeArchive?: () => Promise<void>,
): Promise<"live" | "missing" | "archived"> {
  try {
    const session = await registry.get(name);
    if (session.name !== name) throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "session_not_found") return "missing";
    throw error;
  }
  const state = await registry.observeAgentLiveness(name, agent);
  if (state === "running") return "live";
  if (state !== "stopped") throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
  const digest = createHash("sha256").update(JSON.stringify({ name, archiveKey })).digest("hex").slice(0, 40);
  const archivedName = `provider-auth-ended-${digest}`;
  if (!registry.archiveStopped) throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
  await beforeArchive?.();
  const archived = await registry.archiveStopped(name, archivedName, agent);
  if (archived.name !== archivedName) throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
  return "archived";
}
