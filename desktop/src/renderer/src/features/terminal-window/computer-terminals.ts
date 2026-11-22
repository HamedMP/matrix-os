// Reads and changes one computer's terminal tabs through that computer's own
// gateway. The gateway is the only source of truth: nothing here is cached
// beyond the last listing shown in the sidebar.
import { z } from "zod/v4";
import { TerminalTabIdSchema, TerminalWorkspaceIdSchema } from "@matrix-os/contracts";
import { AppError } from "../../../../shared/app-error";
import type { ApiClient } from "../../lib/api";
import { terminalRefKey } from "../../lib/terminal-workspaces";

const MAX_TABS_SHOWN = 200;

// Only the fields the sidebar shows are read; the gateway owns the full shape.
const ListingSchema = z.object({
  workspaces: z.array(z.object({
    id: TerminalWorkspaceIdSchema,
    scope: z.enum(["main", "project"]),
    projectId: z.string().max(128).optional(),
    tabs: z.array(z.object({
      id: TerminalTabIdSchema,
      name: z.string().max(256),
      status: z.string().max(32),
    })).max(10_000),
  })).max(1_000),
});
const EnsuredSchema = z.object({ workspace: z.object({ id: TerminalWorkspaceIdSchema }) });
const CreatedSchema = z.object({ tab: z.object({ id: TerminalTabIdSchema, name: z.string().max(256) }) });

export interface ComputerTerminalTab {
  refKey: string;
  name: string;
  /** "main" or the project the tab's workspace belongs to. */
  group: string;
  ended: boolean;
}

export type ComputerTerminalsFailure = "reconnect" | "unavailable";

export function terminalsFailure(error: unknown): ComputerTerminalsFailure {
  return error instanceof AppError && (error.category === "unauthorized" || error.category === "fatalSession")
    ? "reconnect"
    : "unavailable";
}

export async function listComputerTabs(api: ApiClient): Promise<ComputerTerminalTab[]> {
  const listing = ListingSchema.parse(await api.get("/api/terminal/workspaces"));
  return listing.workspaces.flatMap((workspace) => workspace.tabs.map((tab) => ({
    refKey: terminalRefKey({ workspaceId: workspace.id, tabId: tab.id }),
    name: tab.name,
    group: workspace.scope === "project" ? workspace.projectId ?? "project" : "main",
    ended: tab.status === "exited" || tab.status === "failed",
  }))).slice(0, MAX_TABS_SHOWN);
}

/** Creates a tab in the computer's unscoped `main` workspace and returns its key. */
export async function createComputerTab(api: ApiClient, name: string): Promise<string> {
  const { workspace } = EnsuredSchema.parse(await api.post("/api/terminal/workspaces/ensure", {}));
  const { tab } = CreatedSchema.parse(
    await api.post(`/api/terminal/workspaces/${encodeURIComponent(workspace.id)}/tabs`, { name, cwd: "" }),
  );
  return terminalRefKey({ workspaceId: workspace.id, tabId: tab.id });
}

const RevisionListingSchema = z.object({
  workspaces: z.array(z.object({
    id: TerminalWorkspaceIdSchema,
    tabs: z.array(z.object({ id: TerminalTabIdSchema, revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) })).max(10_000),
  })).max(1_000),
});

/** Renames a computer tab; the gateway checks the name and the revision it was read at. */
export async function renameComputerTab(api: ApiClient, ref: { workspaceId: string; tabId: string }, name: string): Promise<void> {
  const listing = RevisionListingSchema.parse(await api.get("/api/terminal/workspaces"));
  const tab = listing.workspaces.find((workspace) => workspace.id === ref.workspaceId)?.tabs.find((entry) => entry.id === ref.tabId);
  if (!tab) throw new AppError("notFound");
  await api.patch(`/api/terminal/workspaces/${encodeURIComponent(ref.workspaceId)}/tabs/${encodeURIComponent(ref.tabId)}`, {
    name, baseRevision: tab.revision,
  });
}

/** Ends a computer tab's program and removes the tab. */
export async function closeComputerTab(api: ApiClient, ref: { workspaceId: string; tabId: string }): Promise<void> {
  await api.delete(`/api/terminal/workspaces/${encodeURIComponent(ref.workspaceId)}/tabs/${encodeURIComponent(ref.tabId)}`);
}
