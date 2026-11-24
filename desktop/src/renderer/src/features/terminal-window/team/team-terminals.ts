// Spec 2710: terminals teammates shared with this person, for the Terminal
// window's Team section. The platform lists scopes (metadata only); each
// terminal's name, computer label, owner and role come from the owner's own
// computer, so a hosted VPS and an owned machine read exactly the same way.
import {
  CollaborationDiscoveryResponseSchema,
  TeamTerminalProjectionSchema,
  type CollaborationRole,
  type TeamTerminalProjection,
} from "@matrix-os/contracts";
import { z } from "zod/v4";

export const TEAM_SESSION_PREFIX = "team:";
const TEAM_MACHINE = "team";
const MAX_TEAM_TERMINALS = 200;
const HYDRATION_CONCURRENCY = 8;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const teamRowKey = (scopeId: string) => `${TEAM_MACHINE}|${scopeId}`;
export const teamSessionName = (scopeId: string) => `${TEAM_SESSION_PREFIX}${scopeId}`;

/** The shared terminal a Team row or pane key names, or null for every other key. */
export function teamScopeFromKey(key: string): string | null {
  const prefix = `${TEAM_MACHINE}|`;
  if (!key.startsWith(prefix)) return null;
  const scopeId = key.slice(prefix.length);
  return UUID.test(scopeId) ? scopeId : null;
}

export function teamScopeFromSession(sessionName: string): string | null {
  if (!sessionName.startsWith(TEAM_SESSION_PREFIX)) return null;
  const scopeId = sessionName.slice(TEAM_SESSION_PREFIX.length);
  return UUID.test(scopeId) ? scopeId : null;
}

export type TeamTerminal =
  | { kind: "ready"; scopeId: string; ownerId: string; runtimeId: string; projection: TeamTerminalProjection }
  | { kind: "pending"; scopeId: string; ownerId: string; runtimeId: string; grantId: string }
  | { kind: "offline"; scopeId: string; ownerId: string; runtimeId: string };

/** "Nima's team-dev-1", or the owner alone while the computer is unnamed. */
export function teamComputerName(projection: Pick<TeamTerminalProjection, "owner" | "computerLabel">): string {
  const owner = projection.owner.displayName.trim().split(/\s+/)[0] || "Teammate";
  return projection.computerLabel ? `${owner}'s ${projection.computerLabel}` : `${owner}'s computer`;
}

export function roleLabel(role: CollaborationRole): string {
  return role === "viewer" ? "Viewer" : role === "owner" ? "Owner" : "Editor";
}

export interface TeamTerminalsApi {
  get(path: string): Promise<unknown>;
  getDiscovery(path: string): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
}

type DiscoveryItem = z.infer<typeof CollaborationDiscoveryResponseSchema>["items"][number];

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- a bounded worker pool: each worker takes the next item in turn.
      results[index] = await fn(items[index]!);
    }
  }));
  return results;
}

function terminalItems(items: readonly DiscoveryItem[]): DiscoveryItem[] {
  return items.filter((item) => item.kind === "terminal" && UUID.test(item.scopeId));
}

const MAX_DISCOVERY_PAGES = 10;

/** Terminal items from a discovery list, following its cursor for at most ten pages. */
async function discoverTerminals(api: TeamTerminalsApi, path: string): Promise<DiscoveryItem[]> {
  const found: DiscoveryItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_DISCOVERY_PAGES && found.length < MAX_TEAM_TERMINALS; page += 1) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- pages are read in order: each needs the previous cursor.
    const response = CollaborationDiscoveryResponseSchema.parse(await api.getDiscovery(
      `${path}?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    ));
    found.push(...terminalItems(response.items));
    cursor = response.nextCursor;
    if (!cursor) break;
  }
  return found;
}

/**
 * Every terminal shared with this person: accepted ones hydrated from their
 * owner's computer, pending organization or member grants ready to open.
 */
export async function listTeamTerminals(api: TeamTerminalsApi): Promise<TeamTerminal[]> {
  // Discovery pages hold every kind of share, so terminals can sit past the first page.
  const [inbox, shared] = await Promise.all([
    discoverTerminals(api, "/api/collaboration/inbox"),
    discoverTerminals(api, "/api/collaboration/shared"),
  ]);
  const items = [...inbox, ...shared];
  const unique = [...new Map(items.map((item) => [item.scopeId, item])).values()].slice(0, MAX_TEAM_TERMINALS);
  return mapLimited(unique, HYDRATION_CONCURRENCY, async (item): Promise<TeamTerminal> => {
    const base = { scopeId: item.scopeId, ownerId: item.ownerId, runtimeId: item.runtimeId };
    if (item.status === "organization_pending" && "grantId" in item && item.grantId) return { kind: "pending", ...base, grantId: item.grantId };
    try {
      const projection = TeamTerminalProjectionSchema.parse(await api.get(`/api/collaboration/scopes/${item.scopeId}/terminal/team`));
      return { kind: "ready", ...base, projection };
    } catch (error: unknown) {
      console.warn("[terminal-window] team terminal unavailable:", error instanceof Error ? error.name : "UnknownError");
      return { kind: "offline", ...base };
    }
  });
}

/** Opening a pending share accepts it on the owner's computer; nothing else grants access. */
export async function acceptTeamTerminal(api: TeamTerminalsApi, terminal: Extract<TeamTerminal, { kind: "pending" }>): Promise<void> {
  z.object({ state: z.literal("active") }).parse(await api.post(
    `/api/collaboration/scopes/${encodeURIComponent(terminal.scopeId)}/grants/${encodeURIComponent(terminal.grantId)}/accept`, {},
  ));
}

/** Team terminals grouped by the computer they run on, in a steady order. */
export function groupTeamTerminals(terminals: readonly TeamTerminal[]): Array<{ id: string; name: string; terminals: TeamTerminal[] }> {
  const groups = new Map<string, { id: string; name: string; terminals: TeamTerminal[] }>();
  for (const terminal of terminals) {
    const id = `${terminal.ownerId}|${terminal.runtimeId}`;
    const name = terminal.kind === "ready" ? teamComputerName(terminal.projection) : "Teammate's computer";
    const group = groups.get(id) ?? { id, name, terminals: [] };
    if (terminal.kind === "ready") group.name = name;
    group.terminals.push(terminal);
    groups.set(id, group);
  }
  return [...groups.values()].sort((left, right) => left.name.localeCompare(right.name));
}
