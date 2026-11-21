// Reads and changes one computer's terminal tabs through that computer's own
// gateway. The gateway is the only source of truth: nothing here is cached
// beyond the last listing shown in the sidebar.
import { z } from "zod/v4";
import { TerminalTabIdSchema, TerminalWorkspaceIdSchema } from "@matrix-os/contracts";
import { AppError } from "../../../../shared/app-error";
import type { ApiClient } from "../../lib/api";
import { terminalRefKey } from "../../lib/terminal-workspaces";
import { herdrSessionRefKey, loadHerdrSessions, shouldShowHerdrSessions } from "@matrix-os/ui/herdr-sessions";
import { herdrSessionsRequest } from "../terminal/herdr-desktop-session";

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

/**
 * Why starting a terminal on a computer failed, bounded and safe to show: the
 * kind of failure and, for an HTTP answer, only its status number. Nothing the
 * computer said is passed on.
 */
export type ComputerCreateFailure =
  | { kind: "timeout" | "offline" | "unexpected" | "unknown" }
  | { kind: "refused" | "server"; status: number };

export function createFailure(error: unknown): ComputerCreateFailure {
  if (error instanceof z.ZodError) return { kind: "unexpected" };
  if (!(error instanceof AppError)) return { kind: "unknown" };
  // A successful answer whose body is not JSON: the API client wraps the parse error.
  if (error.category === "server" && error.httpStatus === undefined && error.cause instanceof SyntaxError) return { kind: "unexpected" };
  if (error.category === "timeout" || error.category === "offline") return { kind: error.category };
  const status = error.httpStatus;
  if (status === undefined || !Number.isInteger(status) || status < 400 || status > 599) return { kind: "unknown" };
  return { kind: status < 500 ? "refused" : "server", status };
}

/** The row's line for a failed start: what happened, never the computer's own words. */
export function createFailureText(failure: ComputerCreateFailure): string {
  switch (failure.kind) {
    case "timeout": return "Couldn't start a terminal: the computer did not answer in time. Try again.";
    case "offline": return "Couldn't start a terminal: the computer can't be reached. Try again.";
    case "unexpected": return "Couldn't start a terminal: the computer's answer wasn't understood. It may need an update.";
    case "refused": return `Couldn't start a terminal: the computer refused it (${failure.status}). Try again.`;
    case "server": return `Couldn't start a terminal: the computer had an error (${failure.status}). Try again.`;
    default: return "Couldn't start a terminal. Try again.";
  }
}

export function terminalsFailure(error: unknown): ComputerTerminalsFailure {
  return error instanceof AppError && (error.category === "unauthorized" || error.category === "fatalSession")
    ? "reconnect"
    : "unavailable";
}

export async function listComputerTabs(api: ApiClient): Promise<ComputerTerminalTab[]> {
  const [listed, herdr] = await Promise.all([
    api.get("/api/terminal/workspaces"),
    // The computer's own Herdr sessions through its gateway (spec 2701); a
    // gateway without the adapter lists none, and the SSH path still applies.
    loadHerdrSessions(herdrSessionsRequest(api)).catch((error: unknown) => {
      console.warn("[terminal-window] Herdr sessions unavailable:", error instanceof Error ? error.name : "unknown");
      return null;
    }),
  ]);
  const listing = ListingSchema.parse(listed);
  const tabs = listing.workspaces.flatMap((workspace) => workspace.tabs.map((tab) => ({
    refKey: terminalRefKey({ workspaceId: workspace.id, tabId: tab.id }),
    name: tab.name,
    group: workspace.scope === "project" ? workspace.projectId ?? "project" : "main",
    ended: tab.status === "exited" || tab.status === "failed",
  })));
  const herdrTabs = shouldShowHerdrSessions(herdr) ? herdr!.sessions.map((session) => ({
    refKey: herdrSessionRefKey(session), name: session.title, group: "herdr", ended: false,
  })) : [];
  return [...tabs, ...herdrTabs].slice(0, MAX_TABS_SHOWN);
}

/**
 * Creates a tab and returns its key: in the computer's unscoped `main`
 * workspace, or beside another tab (its workspace and folder) for a split.
 */
export async function createComputerTab(api: ApiClient, name: string, beside?: { workspaceId: string; cwd: string }): Promise<string> {
  const workspaceId = beside?.workspaceId
    ?? EnsuredSchema.parse(await api.post("/api/terminal/workspaces/ensure", {})).workspace.id;
  const { tab } = CreatedSchema.parse(
    await api.post(`/api/terminal/workspaces/${encodeURIComponent(workspaceId)}/tabs`, { name, cwd: beside?.cwd ?? "" }),
  );
  return terminalRefKey({ workspaceId, tabId: tab.id });
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
