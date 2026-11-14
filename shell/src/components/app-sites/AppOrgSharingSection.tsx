"use client";

import type { ComponentType, ReactNode } from "react";
import type { CollaborativeAppShareStatus } from "@matrix-os/ui/collaborative-app-sharing";
import {
  appOrgReadinessLabel,
  appOrgStatusLine,
  appOrgUnavailableLabel,
  type AppOrgSharing,
} from "./app-org-sharing";

/** The shell's own button, so each client keeps its control styling. */
export type AppOrgShareButton = ComponentType<{
  tone: "primary" | "secondary";
  disabled?: boolean;
  className?: string;
  onClick: () => void;
  children: ReactNode;
}>;

const MUTED = "var(--muted-foreground, var(--text-secondary, GrayText))";
const BORDER = "var(--border, var(--border-default, color-mix(in srgb, CanvasText 18%, transparent)))";

const DOT_COLOR: Record<CollaborativeAppShareStatus["kind"], string> = {
  active: "var(--success)",
  needs_recheck: "var(--warning)",
  unavailable: "var(--danger)",
  loading: "transparent",
  not_shared: "transparent",
  stopped: "transparent",
};

/** Status text and indicator; green appears only for a freshly confirmed active share. */
export function AppOrgSharingSummary({ controller }: { controller: AppOrgSharing }) {
  const { status, shared, organizationName: name } = controller;
  const outlined = status.kind === "loading" || status.kind === "not_shared" || status.kind === "stopped";
  return <>
    <span
      aria-hidden="true"
      data-sharing-status={status.kind}
      className="size-2 shrink-0 rounded-full"
      style={{ background: DOT_COLOR[status.kind], boxShadow: outlined ? `inset 0 0 0 1.5px var(--text-tertiary, ${MUTED})` : undefined }}
    />
    <span className="min-w-0 flex-1">
      <span className="block truncate font-medium">{shared ? `Shared with ${name ?? "your organization"}` : "Share with your organization"}</span>
      <span className="block truncate text-xs" style={{ color: MUTED }}>{appOrgStatusLine(controller)}</span>
    </span>
  </>;
}

function OrganizationShareControls({ controller, Button }: { controller: AppOrgSharing; Button: AppOrgShareButton }) {
  const { sharing, status, shared, busy, organizationId } = controller;
  const checking = sharing.state === "loading" || sharing.state === "checking";
  if (!organizationId) {
    return <p role="status" className="text-xs" style={{ color: MUTED }}>{appOrgUnavailableLabel(controller)}</p>;
  }
  return <>
    {status.kind !== "active" ? (
      <div className="flex items-center justify-between gap-2">
        <p role="status" className="min-w-0 text-xs" style={{ color: MUTED }}>
          <span className="font-medium">App build:</span> <span>{appOrgReadinessLabel(sharing)}</span>
        </p>
        <Button tone="secondary" className="shrink-0" disabled={checking || busy} onClick={controller.check}>Check collaboration</Button>
      </div>
    ) : null}
    <div className="flex flex-wrap gap-2">
      {shared ? (
        <Button tone="secondary" disabled={!sharing.shareKnown || busy} onClick={() => { void controller.stop(); }}>
          {sharing.actionState === "stopping" ? "Stopping…" : "Stop sharing"}
        </Button>
      ) : (
        <Button tone="primary" disabled={!sharing.shareKnown || !sharing.canShare || busy} onClick={() => { void controller.create(); }}>
          {sharing.actionState === "sharing" ? "Sharing…" : "Share with your org"}
        </Button>
      )}
    </div>
  </>;
}

/**
 * Owner-home app sharing stays separate from Matrix.page publication. Build readiness,
 * the share's state, and the app's own data health are reported separately.
 */
export function AppOrgSharingDetails({ controller, Button, members }: {
  controller: AppOrgSharing;
  Button: AppOrgShareButton;
  /** The roster of the organization that can, or would, use the app. */
  members?: ReactNode;
}) {
  return <div className="space-y-4 text-[13px]">
    <section aria-label="Share with your org" className="space-y-3">
      <div role="status" className="flex items-center gap-2.5 rounded-lg border px-3 py-2.5" style={{ borderColor: BORDER }}>
        <AppOrgSharingSummary controller={controller} />
      </div>
      <p className="text-xs leading-5" style={{ color: MUTED }}>
        All current members, including guests, can use existing app data and make changes. The app and its data stay on your Matrix. Stopping sharing removes their access without deleting your records. These checks cover the app build and access, not whether the running app is healthy.
      </p>
      <OrganizationShareControls controller={controller} Button={Button} />
      {controller.sharing.actionMessage ? (
        <p role="alert" className="text-xs" style={{ color: "var(--danger-text, var(--destructive-text, var(--text-primary, CanvasText)))" }}>
          {controller.sharing.actionMessage}
        </p>
      ) : null}
    </section>
    {controller.organizationId ? members : null}
  </div>;
}
