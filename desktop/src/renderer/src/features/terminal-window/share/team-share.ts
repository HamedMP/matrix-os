// Spec 2710: the owner's side of a team terminal, over the same direct
// collaboration client Web and Electron use. Every decision is the owner
// computer's: these calls only ask it. A scope with no grants grants nothing,
// so a share that stops half-way never widens access.
import {
  CollaborationGrantSchema,
  CollaborationScopePreflightResponseSchema,
  CollaborationScopeSchema,
  CollaborationTerminalSchema,
  type CollaborationScope,
  type CollaborationTeamTerminalInputMode,
} from "@matrix-os/contracts";
import { z } from "zod/v4";

/** The calls a share needs; `CollaborationDirectApi` provides them. */
export interface TeamShareApi {
  get(path: string): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
  put?(path: string, body?: unknown): Promise<unknown>;
  patch?(path: string, body?: unknown): Promise<unknown>;
  delete(path: string, body?: unknown): Promise<unknown>;
}

export class TeamShareError extends Error {
  constructor(public readonly code: "unavailable" | "not_shareable") {
    super("Team terminal sharing is unavailable");
    this.name = "TeamShareError";
  }
}

const GrantsSchema = z.array(CollaborationGrantSchema).max(100);
const MAX_GRANTS_REVOKED = 100;

const scopePath = (scopeId: string) => `/api/collaboration/scopes/${encodeURIComponent(scopeId)}`;
const requestId = () => crypto.randomUUID();

/**
 * Shares one canonical tab (`workspaceId:tabId`) with an organization, or
 * returns the existing share for it, and records the computer's name.
 */
export async function prepareTeamTerminal(api: TeamShareApi, input: {
  runtimeId: string;
  organizationId: string;
  terminalId: string;
  computerLabel: string;
}): Promise<CollaborationScope> {
  const runtime = `/api/collaboration/runtimes/${encodeURIComponent(input.runtimeId)}`;
  const preflight = CollaborationScopePreflightResponseSchema.parse(await api.post(`${runtime}/scopes/preflight`, {
    kind: "terminal", resourceId: input.terminalId, organizationId: input.organizationId,
  }));
  if (!preflight.eligible && !preflight.existingScopeId) throw new TeamShareError("not_shareable");
  let scopeId = preflight.existingScopeId;
  if (!scopeId) {
    const created = CollaborationScopeSchema.parse(await api.post(`${runtime}/scopes`, {
      kind: "terminal",
      resourceId: input.terminalId,
      organizationId: input.organizationId,
      clientRequestId: requestId(),
      expectedRevision: preflight.resourceRevision,
      confirmationToken: preflight.confirmationToken,
    }));
    scopeId = created.id;
  }
  if (!api.put) throw new TeamShareError("unavailable");
  await api.put(`${scopePath(scopeId)}/terminal/team/label`, { computerLabel: input.computerLabel.trim().slice(0, 64) });
  return CollaborationScopeSchema.parse(await api.get(scopePath(scopeId)));
}

async function liveGrants(api: TeamShareApi, scopeId: string) {
  const grants = GrantsSchema.parse(await api.get(`${scopePath(scopeId)}/grants`));
  return grants.filter((grant) => grant.state === "active" || grant.state === "pending");
}

/**
 * Editors may type only once the owner opts this host shell in. Sharing with
 * an editor is that opt-in (the dialog says so); no editor withdraws it.
 */
export async function syncEditorTyping(api: TeamShareApi, scopeId: string): Promise<boolean> {
  if (!api.patch) throw new TeamShareError("unavailable");
  const editors = (await liveGrants(api, scopeId)).some((grant) => grant.preset === "contributor");
  await api.patch(`${scopePath(scopeId)}/terminal`, { contributorControl: editors });
  return editors;
}

/** Ends every grant, then withdraws typing. Live sockets close when each grant commits. */
export async function stopSharingTeamTerminal(api: TeamShareApi, scopeId: string): Promise<void> {
  const grants = (await liveGrants(api, scopeId)).slice(0, MAX_GRANTS_REVOKED);
  for (const grant of grants) {
    // Each revocation moves the scope revision, so the next one reads it again.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- revocations are ordered: each needs the revision the previous one committed.
    const scope = CollaborationScopeSchema.parse(await api.get(scopePath(scopeId)));
    await api.delete(`${scopePath(scopeId)}/grants/${encodeURIComponent(grant.id)}`, {
      clientRequestId: requestId(),
      expectedRevision: scope.revision,
      expectedMemberRevision: grant.revision,
    });
  }
  if (api.patch) await api.patch(`${scopePath(scopeId)}/terminal`, { contributorControl: false });
}

/** The owner takes control (`owner`) or hands it back (`shared`). */
export async function setTeamInputMode(api: TeamShareApi, scopeId: string, mode: CollaborationTeamTerminalInputMode): Promise<void> {
  const terminal = CollaborationTerminalSchema.parse(await api.get(`${scopePath(scopeId)}/terminal`));
  await api.post(`${scopePath(scopeId)}/terminal/actions`, {
    type: "input_mode", clientRequestId: requestId(), incarnation: terminal.incarnation, mode,
  });
}

/** The existing share of a tab, if the owner shared it before; nothing is created. */
export async function findTeamTerminal(api: TeamShareApi, input: { runtimeId: string; organizationId: string; terminalId: string }): Promise<CollaborationScope | null> {
  const preflight = CollaborationScopePreflightResponseSchema.parse(await api.post(
    `/api/collaboration/runtimes/${encodeURIComponent(input.runtimeId)}/scopes/preflight`,
    { kind: "terminal", resourceId: input.terminalId, organizationId: input.organizationId },
  ));
  if (!preflight.existingScopeId) return null;
  return CollaborationScopeSchema.parse(await api.get(scopePath(preflight.existingScopeId)));
}
