"use client";
import { useState } from "react";
import type { CollaborativeAppShare } from "@matrix-os/contracts";
import { useCollaborativeAppSharing, type CollaborativeAppReadinessApi } from "../collaboration/useCollaborativeAppSharing";
import { OrganizationTab } from "./OrganizationTab";
import type { ShareOrganization } from "./organization-identity";
import type { ShareOrganizationSlot } from "./SharePanel";
import { useCollaborativeHandoff, type HandoffFileApi } from "./use-collaborative-handoff";
import { useOrganizationShareFlow } from "./use-organization-share-flow";

/** Name of the builder skill the Chats handoff invokes (skills/matrix/collaborative-app-builder). */
export const MAKE_COLLABORATIVE_SKILL = "matrix-collaborative-app-builder";

/**
 * First message of the new chat. It mentions the app, the skill and the target
 * org, and carries the handoff ids the skill echoes back in its completion record.
 */
export function collaborativeChatPrompt(input: { appName: string; appSlug: string; organizationName: string; organizationId: string; requestId: string }): string {
  return [
    `/${MAKE_COLLABORATIVE_SKILL} @${input.appName}`,
    `${input.organizationName} members will use this app together. Make it collaborative so they can share its data, then turn on sharing.`,
    "",
    `Share handoff: app ${input.appSlug}, organization ${input.organizationId}, request ${input.requestId}.`,
  ].join("\n");
}

export interface ShareOrganizationHost {
  appSlug: string;
  appName: string;
  /** Current memberships; empty hides the Organization tab. `null` while loading. */
  organizations: ShareOrganization[] | null;
  /** Preferred org (the active one) when the app is not shared yet. */
  preferredOrganizationId: string | null;
  collaborationApi: CollaborativeAppReadinessApi | null;
  fileApi: HandoffFileApi | null;
  buildEpoch?: number;
  /** Opens Matrix Chats on a NEW chat and sends `prompt` as its first message. */
  startChat: (prompt: string) => Promise<boolean>;
  openChat: () => void;
  /** False for Matrix default apps: an existing org share can be stopped, never started. */
  allowNewSharing?: boolean;
  /** Absolute org link for Copy; `hints` are display-only names for the hand-off page. */
  orgLink: (share: CollaborativeAppShare, hints: { app: string; org: string }) => string | null;
}

/**
 * Org sharing state for one app window. Kept mounted by the header host so the
 * builder skill's completion event is applied even while the popover is closed.
 */
export function useShareOrganization(host: ShareOrganizationHost): { slot: ShareOrganizationSlot | null; shared: boolean } {
  const enabled = host.collaborationApi !== null && (host.organizations?.length ?? 0) > 0;
  const sharing = useCollaborativeAppSharing({
    appId: host.appSlug,
    api: host.collaborationApi ?? inertApi,
    buildEpoch: host.buildEpoch,
    manageShare: enabled,
  });
  // A stop-only app never reads the Chats setup record, so a setup that finishes
  // (even one started before the app became stop-only) cannot create a new share.
  const handoff = useCollaborativeHandoff({ appSlug: host.appSlug, api: enabled && host.allowNewSharing !== false ? host.fileApi : null });
  const organizations = host.organizations ?? [];
  const [chosenId, setChosenId] = useState<string | null>(null);
  const flow = useOrganizationShareFlow({
    sharing, handoff,
    onStartChat: async ({ organizationId, requestId }) => {
      const organization = organizations.find((item) => item.organizationId === organizationId);
      if (!organization) return false;
      return host.startChat(collaborativeChatPrompt({ appName: host.appName, appSlug: host.appSlug, organizationName: organization.name, organizationId, requestId }));
    },
  });
  if (!enabled) return { slot: null, shared: false };
  // A stop-only app shows the Organization tab only while it is shared.
  if (host.allowNewSharing === false && !flow.shared) return { slot: null, shared: false };
  const selected = selectOrganization(organizations, [
    flow.shared ? sharing.share?.organizationId : null, flow.runningOrganizationId, chosenId, host.preferredOrganizationId,
  ]);
  const busy = sharing.actionState !== "idle" && sharing.actionState !== "failed";
  return {
    shared: flow.shared,
    slot: {
      shared: flow.shared,
      content: <OrganizationTab organizations={organizations} selectedId={selected.organizationId} onSelect={setChosenId}
        flow={flow} orgLink={sharing.share && flow.shared ? safeOrgLink(host, sharing.share, selected.name) : null} onOpenChat={host.openChat} busy={busy} />,
    },
  };
}

function safeOrgLink(host: ShareOrganizationHost, share: CollaborativeAppShare, organizationName: string): string | null {
  try {
    return host.orgLink(share, { app: host.appName, org: organizationName });
  } catch (error: unknown) {
    console.warn("[share] org link unavailable", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

/** A live share or running handoff pins the org; otherwise the owner's pick, then the active org. */
function selectOrganization(organizations: ShareOrganization[], preferences: Array<string | null | undefined>): ShareOrganization {
  const byId = new Map(organizations.map((item) => [item.organizationId, item]));
  for (const id of preferences) {
    const match = id ? byId.get(id) : undefined;
    if (match) return match;
  }
  return organizations[0]!;
}

const inertApi: CollaborativeAppReadinessApi = {
  get: () => Promise.reject(new Error("Organization sharing unavailable")),
  post: () => Promise.reject(new Error("Organization sharing unavailable")),
};
