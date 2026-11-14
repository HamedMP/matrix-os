import type { CollaborativeAppShare } from "@matrix-os/contracts";
import type { CollaborativeAppSharingActionState } from "./useCollaborativeAppSharing.js";

/**
 * The owner-facing organization share status. `active` is reported only when the
 * current share read confirmed an active share: a pending or failed read never
 * inherits an earlier answer, and build readiness or app data health play no part.
 */
export type CollaborativeAppShareStatus =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "not_shared" }
  | { kind: "active"; organizationId: string }
  | { kind: "needs_recheck"; organizationId: string }
  | { kind: "stopped"; organizationId: string };

export function deriveCollaborativeAppShareStatus(sharing: {
  share: CollaborativeAppShare | null;
  shareKnown: boolean;
  actionState: CollaborativeAppSharingActionState;
}): CollaborativeAppShareStatus {
  if (!sharing.shareKnown) return sharing.actionState === "loading" ? { kind: "loading" } : { kind: "unavailable" };
  if (!sharing.share) return { kind: "not_shared" };
  return { kind: sharing.share.state, organizationId: sharing.share.organizationId };
}

/** The organization whose members can use the app: an existing share's, otherwise the one the owner would share with. */
export function collaborativeAppShareOrganizationId(
  status: CollaborativeAppShareStatus,
  selectedOrganizationId: string | null,
): string | null {
  return status.kind === "active" || status.kind === "needs_recheck" ? status.organizationId : selectedOrganizationId;
}
