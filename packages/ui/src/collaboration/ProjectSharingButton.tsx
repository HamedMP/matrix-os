import type { CollaborationApi } from "./ChatCollaboratorsDialog.js";
import { PROJECT_SHARING_UNAVAILABLE_MESSAGE, useProjectSharing } from "./useProjectSharing.js";

const buttonClass = "rounded-lg border px-3 py-2 text-sm transition-colors hover:enabled:bg-[var(--bg-hover)] disabled:opacity-50";

export function ProjectSharingButton({ api, runtimeId, organizationId, projectId, projectName }: {
  api: CollaborationApi;
  runtimeId: string | null;
  /** The Clerk organization this share is scoped to; without one there is nothing to share with. */
  organizationId: string | null;
  projectId: string;
  projectName: string;
}) {
  const sharing = useProjectSharing({ api, runtimeId, organizationId, projectId, projectName });
  return <div className="relative inline-flex shrink-0 items-center">
    <button type="button" className={buttonClass} aria-label="Share project" disabled={sharing.pending || !runtimeId || !organizationId}
      aria-expanded={sharing.open} onClick={() => sharing.open ? sharing.close() : sharing.start()}>
      {sharing.pending || !runtimeId ? "Loading share…" : !organizationId ? "Join an organization to share" : "Share"}
    </button>
    {sharing.error ? <span role="alert" className="absolute right-0 top-full z-50 mt-2 w-72 rounded-lg border bg-[var(--bg-surface,var(--background))] p-3 shadow-lg">
      {PROJECT_SHARING_UNAVAILABLE_MESSAGE}
    </span> : null}
    {sharing.dialogs}
  </div>;
}
