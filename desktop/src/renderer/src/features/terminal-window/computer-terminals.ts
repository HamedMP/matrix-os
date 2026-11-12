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
