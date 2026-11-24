// Spec 2710: the Terminal window's own collaboration client. It does not use
// the main window's connection store (spec 651); the trusted core signs its
// platform requests as the account and its relay requests carry only the
// direct-session proof this renderer holds.
import { OrganizationManagementListSchema, type OrganizationManagementSummary } from "@matrix-os/contracts";
import type { CollaborationDirectApi } from "@matrix-os/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod/v4";
import { collaborationRuntimeIdFromSystemInfo, createDesktopCollaborationApi, releaseDesktopCollaborationApi } from "../../../lib/collaboration";
import { createApiClient } from "../../../lib/api";

const OrganizationsSchema = z.union([
  OrganizationManagementListSchema,
  z.looseObject({ organizations: z.array(z.looseObject({ organizationId: z.string(), name: z.string() })).max(100) }),
]);

export type TeamOrganization = Pick<OrganizationManagementSummary, "organizationId" | "name">;

/** The window's collaboration client, made on first use so opening the window costs no request. */
export interface TeamCollaboration {
  api(): CollaborationDirectApi | null;
  /** The person's organizations, read once per signed-in session. */
  organizations(): Promise<TeamOrganization[]>;
}

export type TeamCollaborationState =
  | { status: "loading" }
  | { status: "none" }
  | { status: "failed" }
  | { status: "ready"; api: CollaborationDirectApi; organizations: TeamOrganization[] };

async function readOrganizations(api: CollaborationDirectApi): Promise<TeamOrganization[]> {
  const parsed = OrganizationsSchema.parse(await api.get("/api/organizations"));
  return parsed.organizations
    .filter((organization) => /^org_[A-Za-z0-9_-]{1,124}$/.test(organization.organizationId))
    .map((organization) => ({ organizationId: organization.organizationId, name: organization.name.slice(0, 200) }));
}

export function useTeamCollaboration(platformHost: string | null, sessionKey: string): TeamCollaboration {
  const current = useRef<{ key: string; api: CollaborationDirectApi | null; organizations: Promise<TeamOrganization[]> | null } | null>(null);
  const key = `${platformHost ?? ""}|${sessionKey}`;
  // A new session or platform drops the client and its direct sessions.
  useEffect(() => () => {
    const held = current.current;
    current.current = null;
    if (held?.api) releaseDesktopCollaborationApi(held.api);
  }, [key]);
  return useMemo<TeamCollaboration>(() => {
    const entry = () => {
      if (current.current?.key !== key) {
        current.current = { key, api: platformHost ? createDesktopCollaborationApi(platformHost) : null, organizations: null };
      }
      return current.current;
    };
    return {
      api: () => entry().api,
      organizations: () => {
        const held = entry();
        if (!held.api) return Promise.resolve([]);
        held.organizations ??= readOrganizations(held.api).catch((error: unknown) => {
          held.organizations = null;
          throw error;
        });
        return held.organizations;
      },
    };
  }, [key, platformHost]);
}

/** Loads the client and organizations when a dialog needs them. */
export function useTeamCollaborationState(team: TeamCollaboration, enabled: boolean): TeamCollaborationState {
  const [state, setState] = useState<TeamCollaborationState>({ status: "loading" });
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- organizations are read only when the share dialog opens, once per session.
  useEffect(() => {
    if (!enabled) return;
    const api = team.api();
    if (!api) { setState({ status: "failed" }); return; }
    let active = true;
    setState({ status: "loading" });
    team.organizations().then((organizations) => {
      if (active) setState(organizations.length ? { status: "ready", api, organizations } : { status: "none" });
    }, (error: unknown) => {
      console.warn("[terminal-window] organizations unavailable:", error instanceof Error ? error.name : "UnknownError");
      if (active) setState({ status: "failed" });
    });
    return () => { active = false; };
  }, [enabled, team]);
  return state;
}

/** The collaboration runtime of one of the person's computers, read from that computer. */
export async function computerRuntimeId(platformHost: string, slot: string): Promise<string | null> {
  const client = createApiClient({ baseUrl: platformHost, getRuntimeSlot: () => slot });
  return collaborationRuntimeIdFromSystemInfo(await client.get("/api/system/info"));
}

