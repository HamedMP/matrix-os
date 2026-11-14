"use client";

import { useId, useState } from "react";
import type { OrganizationManagementMember } from "@matrix-os/contracts";
import type { AppOrgShareButton } from "./AppOrgSharingSection";

/** A bounded roster read; `complete` is false when the read stopped before the last member page. */
export type AppOrgMemberDirectory =
  | { state: "loading" }
  | { state: "loaded"; members: readonly OrganizationManagementMember[]; complete?: boolean }
  | { state: "failed" };

const MUTED = "var(--muted-foreground, var(--text-secondary, GrayText))";
const PLACEHOLDER = "var(--muted, var(--bg-hover, color-mix(in srgb, CanvasText 8%, transparent)))";

function memberInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0]!, words[words.length - 1]!] : words.slice(0, 1);
  return letters.map((word) => Array.from(word)[0] ?? "").join("").toLocaleUpperCase() || "?";
}

function MemberAvatar({ member }: { member: OrganizationManagementMember }) {
  // Remembering the failed address (not a flag) lets a changed photo try again without an effect.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const box = "inline-flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full";
  if (member.imageUrl && failedUrl !== member.imageUrl) {
    return (
      // react-doctor-disable-next-line react-doctor/nextjs-no-img-element -- validated https profile photo shared with Electron; next/image is unavailable there and the error fallback needs a plain <img>.
      <img
        src={member.imageUrl}
        alt=""
        width={28}
        height={28}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailedUrl(member.imageUrl ?? null)}
        className={`${box} object-cover`}
        style={{ background: PLACEHOLDER }}
      />
    );
  }
  return (
    <span aria-hidden="true" data-member-initials="" className={`${box} text-[11px] font-semibold`}
      style={{ background: PLACEHOLDER, color: MUTED }}>
      {memberInitials(member.displayName)}
    </span>
  );
}

function PlaceholderRows() {
  return (
    <ul aria-hidden="true" className="space-y-2">
      {[0, 1, 2].map((row) => (
        <li key={row} className="flex items-center gap-2.5">
          <span className="size-7 shrink-0 rounded-full" style={{ background: PLACEHOLDER }} />
          <span className="h-3 rounded" style={{ width: `${48 - row * 10}%`, background: PLACEHOLDER }} />
        </li>
      ))}
    </ul>
  );
}

/** Current members of the organization that can (or would) use the app; read-only, no per-person access. */
export function AppOrgMemberRoster({ directory, organizationName, currentActorId, onRetry, Button }: {
  directory: AppOrgMemberDirectory;
  organizationName: string;
  currentActorId: string | null;
  onRetry: () => void;
  Button: AppOrgShareButton;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h3 id={headingId} className="flex items-baseline gap-1.5 text-xs font-semibold" style={{ color: MUTED }}>
        Members
        {directory.state === "loaded" ? (
          <span className="font-normal tabular-nums">{directory.members.length}{directory.complete === false ? "+" : ""}</span>
        ) : null}
      </h3>
      {directory.state === "loading" ? <>
        <p role="status" className="sr-only">Loading members…</p>
        <PlaceholderRows />
      </> : null}
      {directory.state === "failed" ? (
        <div className="flex items-center justify-between gap-2 text-xs">
          <p role="alert" style={{ color: MUTED }}>Members are unavailable.</p>
          <Button tone="secondary" onClick={onRetry}>Try again</Button>
        </div>
      ) : null}
      {directory.state === "loaded" && directory.members.length === 0 ? (
        <p className="text-xs" style={{ color: MUTED }}>No members to show.</p>
      ) : null}
      {directory.state === "loaded" && directory.members.length > 0 ? (
        <ul aria-label={`Members of ${organizationName}`} className="space-y-1">
          {directory.members.map((member) => (
            <li key={member.actorId} className="flex min-w-0 items-center gap-2.5 py-0.5 text-[13px]">
              <MemberAvatar member={member} />
              <span className="min-w-0 flex-1 truncate">
                <span>{member.displayName}</span>
                {member.actorId === currentActorId ? <span style={{ color: MUTED }}> (you)</span> : null}
              </span>
              <span className="shrink-0 text-xs" style={{ color: MUTED }}>
                {member.role === "org:admin" ? "Admin" : "Member"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {directory.state === "loaded" && directory.complete === false ? (
        <p className="text-xs" style={{ color: MUTED }}>
          Showing the first {directory.members.length} members. Every current member can use the app.
        </p>
      ) : null}
    </section>
  );
}
