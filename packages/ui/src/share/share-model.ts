/**
 * Pure state derivation for the Share popover. Renderers (Web Desktop, Web
 * Canvas, Electron Desktop) consume these helpers so copy and mode rules
 * cannot drift between surfaces.
 *
 * Two independent systems:
 *  - Organization sharing (spec 2689): live, creator-hosted app in org launchers.
 *  - Matrix.page publication (specs 551/2690/2691): exactly ONE access mode.
 *
 * One-time links (2690) are retired from the UI (spec 2693): `private_link`
 * stays readable so a legacy site can be turned off, but nothing switches to it.
 */
import { classifySiteSlug, type SiteRecord } from "@matrix-os/contracts";

export type ShareTab = "private" | "organization" | "public";
/** Matrix.page access mode as the owner experiences it. `none` = not published. */
export type PageMode = "none" | "private_email" | "private_link" | "public";
/** A live access mode, including the retired `private_link`. */
export type ActivePageMode = Exclude<PageMode, "none">;
/** Modes the owner can switch to. One-time links are retired, so never `private_link`. */
export type PageModeTarget = Exclude<ActivePageMode, "private_link">;

export function pageModeOf(site: SiteRecord | null, emailModeActive: boolean): PageMode {
  if (emailModeActive) return "private_email";
  if (!site || site.status !== "published") return "none";
  // Forward-compatible with spec 2691, which adds "private_email" to SiteAccessModeSchema.
  const mode: string = site.accessMode;
  if (mode === "private_email") return "private_email";
  return mode === "private_link" ? "private_link" : "public";
}

/** Switching between two active modes revokes the previous access (2691 FR-029). */
export function needsModeSwitchConfirm(current: PageMode, target: PageModeTarget): boolean {
  return current !== "none" && current !== target;
}

const MODE_NAME: Record<PageModeTarget, string> = { public: "public", private_email: "invite-only" };
const MODE_CTA: Record<PageModeTarget, string> = { public: "Make public", private_email: "Make invite-only" };

export interface ModeSwitchCopy { title: string; body: string; cta: string }

export function modeSwitchCopy(current: ActivePageMode, target: PageModeTarget, invitedCount: number | null): ModeSwitchCopy {
  const loss = current === "private_email"
    ? invitedCount === null ? "Invited people lose access, and their invites can’t be restored." : `${invitedCount} invited ${invitedCount === 1 ? "person loses" : "people lose"} access, and their invites can’t be restored.`
    : current === "private_link"
      ? "Existing one-time links stop working."
      : "The public link stops working for visitors.";
  return {
    title: `Switch to ${MODE_NAME[target]}?`,
    body: `${loss} A Matrix.page app has one access mode at a time.`,
    cta: MODE_CTA[target],
  };
}

/**
 * The Private tab exists for email invites, invite-only sites, and legacy
 * one-time-link sites, whose owner still needs a way to stop sharing.
 */
export function privateTabVisible(pageMode: PageMode, emailInvitesAvailable: boolean, allowNewSharing = true): boolean {
  return (allowNewSharing && emailInvitesAvailable) || pageMode === "private_link" || pageMode === "private_email";
}

/** The Public tab offers Publish, so a stop-only app shows it only while it is live. */
export function publicTabVisible(pageMode: PageMode, allowNewSharing = true): boolean {
  return allowNewSharing || pageMode === "public";
}

/**
 * Whether an app window shows Share. Matrix default apps never start sharing
 * (`allowNewSharing` false) but keep Share while something is still shared, so
 * the owner can stop it. While the first read loads `pageMode` is `none` and
 * `orgShared` false, so a default app never flashes a Share button. A failed
 * read keeps Share (with Retry) because the app may still be live, and an open
 * popover stays up while that retry loads.
 */
export function shareEntryVisible(allowNewSharing: boolean, share: { pageMode: PageMode; loading: boolean; loadFailed: boolean }, orgShared: boolean, open: boolean): boolean {
  return allowNewSharing || share.pageMode !== "none" || orgShared || share.loadFailed || (open && share.loading);
}

/** Opens on the tab whose sharing is on; otherwise Public. */
export function defaultShareTab(pageMode: PageMode, orgShared: boolean): ShareTab {
  if (pageMode === "public") return "public";
  if (orgShared) return "organization";
  if (pageMode === "private_link" || pageMode === "private_email") return "private";
  return "public";
}

/** Tab dots: green when that tab's sharing is on. Tabs never change access. */
export function tabIndicators(pageMode: PageMode, orgShared: boolean): Record<ShareTab, boolean> {
  return {
    private: pageMode === "private_email" || pageMode === "private_link",
    organization: orgShared,
    public: pageMode === "public",
  };
}

export type ShareTriggerState = { label: "Share" | "Shared" | "Live"; icon: "share" | "organization" | "live" };

export function shareTriggerState(pageMode: PageMode, orgShared: boolean): ShareTriggerState {
  if (pageMode === "public") return { label: "Live", icon: "live" };
  if (orgShared) return { label: "Shared", icon: "organization" };
  return { label: "Share", icon: "share" };
}

/** Mirrors the design: lowercase, other characters become `-`, no leading/double hyphens, max 63. */
export function normalizeSlugInput(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-{2,}/g, "-").replace(/^-/, "").slice(0, 63);
}

export type SlugState =
  | { kind: "empty" }
  | { kind: "invalid" }
  | { kind: "reserved" }
  | { kind: "checking" }
  | { kind: "available" }
  | { kind: "current" }
  | { kind: "taken"; suggestions: string[] }
  | { kind: "unknown" };

/** Local classification before (or instead of) the debounced platform check. */
export function localSlugState(slug: string, currentSlug: string | null): SlugState | null {
  if (slug === "") return { kind: "empty" };
  const local = classifySiteSlug(slug);
  if (local === "invalid") return { kind: "invalid" };
  if (local === "reserved") return { kind: "reserved" };
  if (currentSlug !== null && slug === currentSlug) return { kind: "current" };
  return null;
}

/**
 * Publish is disabled only for an invalid, reserved or taken path. While a check
 * is in flight publishing stays available; the platform's atomic alias claim
 * still rejects a taken path with 409, which the UI maps back to `taken`.
 */
export function slugBlocksPublish(state: SlugState): boolean {
  return state.kind === "invalid" || state.kind === "reserved" || state.kind === "taken";
}

export const SHARE_TITLE_MAX = 200;
export const SHARE_DESCRIPTION_MAX = 1000;

export function metadataSummary(title: string, description: string): string {
  return (title.trim() || "Untitled") + (description.trim() ? ` · ${description.trim()}` : "");
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isInviteEmail(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length <= 254 && EMAIL_PATTERN.test(trimmed);
}
