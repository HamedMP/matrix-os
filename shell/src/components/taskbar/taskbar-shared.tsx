"use client";

import { useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { useIconWithFallback } from "@/hooks/useIconWithFallback";
import { useIsClient } from "@/hooks/useIsClient";
import { isSelfHostedDocument } from "@/lib/self-host-mode";

/**
 * Shared visual building blocks for the Windows-design shell chrome (XP +
 * Win11 taskbars and start menus). All styling lives in `taskbar.css`; the
 * CSS color tokens (`--xp-*`, `--win11-*`) are defined in globals.css and
 * only resolve while the matching `data-theme-style` is active on :root.
 * Non-component helpers live in `taskbar-utils.ts`.
 */

/* ── App icon with initial-letter fallback ───────────────── */

export function TaskbarAppIcon({
  name,
  iconUrl,
  size,
}: {
  name: string;
  iconUrl?: string;
  size: number;
}) {
  const { showImage, onError } = useIconWithFallback(iconUrl);
  if (showImage && iconUrl) {
    return (
      // react-doctor-disable-next-line react-doctor/nextjs-no-img-element -- app icon served from a runtime gateway host (/icons/{slug}.png) that cannot be statically configured for next/image
      <img
        src={iconUrl}
        alt=""
        className="taskbar-icon"
        style={{ width: size, height: size }}
        draggable={false}
        onError={onError}
      />
    );
  }
  return (
    <span
      className="taskbar-icon-fallback"
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.5)) }}
      aria-hidden="true"
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

/* ── Clock ────────────────────────────────────────────────── */

function formatTaskbarTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatTaskbarDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "numeric",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * SSR-safe wall clock (same pattern as MenuBarClock): `useIsClient` is false
 * during SSR/hydration so the placeholder renders, and a minute-aligned
 * interval bumps `tick` afterwards so the display advances.
 */
export function TaskbarClock({ variant }: { variant: "xp" | "win11" }) {
  const isClient = useIsClient();
  const [tick, setTick] = useState(0);
  const now = isClient ? new Date() : null;

  // react-doctor-disable-next-line react-doctor/no-cascading-set-state -- setTick only fires from setTimeout/setInterval callbacks (never a synchronous cascade); depending on [tick] re-aligns the next timeout to the upcoming minute boundary after each update.
  useEffect(() => {
    if (!isClient) return;
    const stamp = new Date();
    const ms = (60 - stamp.getSeconds()) * 1000 - stamp.getMilliseconds();
    const bump = () => setTick((t) => t + 1);
    const timeout = setTimeout(bump, ms);
    const interval = setInterval(bump, 60_000);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [isClient, tick]);

  if (variant === "xp") {
    return (
      <span className="xp-tray-clock tabular-nums">{now ? formatTaskbarTime(now) : " "}</span>
    );
  }
  return (
    <span className="win11-tray-clock">
      <span className="tabular-nums">{now ? formatTaskbarTime(now) : " "}</span>
      <span className="tabular-nums">{now ? formatTaskbarDate(now) : " "}</span>
    </span>
  );
}

/* ── Windows logos (inline SVG — the only non-lucide icons) ─ */

export function XpFlagLogo({ size = 18 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 32 26"
      width={size}
      height={Math.round((size * 26) / 32)}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2 5.5 C 7 2.5, 11 2.5, 15 4.5 L 15 12 L 2 12 Z" fill="#f8682c" />
      <path d="M17 4.8 C 21.5 3, 26 3.2, 30 5.5 L 30 12.2 L 17 12.2 Z" fill="#91c300" />
      <path d="M2 13.5 L 15 13.5 L 15 21 C 11 23, 7 23, 2 20 Z" fill="#00b4f1" />
      <path d="M17 13.7 L 30 13.7 L 30 21 C 26 23.2, 21.5 23.2, 17 21.4 Z" fill="#ffc300" />
    </svg>
  );
}

export function Win11Logo({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <rect x="1.5" y="1.5" width="10" height="10" fill="#00adef" />
      <rect x="12.5" y="1.5" width="10" height="10" fill="#00adef" />
      <rect x="1.5" y="12.5" width="10" height="10" fill="#00adef" />
      <rect x="12.5" y="12.5" width="10" height="10" fill="#00adef" />
    </svg>
  );
}

/* ── Start-menu user identity ─────────────────────────────── */

function StartMenuUserView({
  name,
  imageUrl,
  avatarSize,
  className,
}: {
  name: string;
  imageUrl?: string;
  avatarSize: number;
  className?: string;
}) {
  return (
    <div className={className} data-start-menu-user>
      {imageUrl ? (
        // react-doctor-disable-next-line react-doctor/nextjs-no-img-element -- Clerk-hosted avatar URL is runtime data that cannot be statically configured for next/image
        <img
          src={imageUrl}
          alt=""
          className="taskbar-avatar"
          style={{ width: avatarSize, height: avatarSize }}
          draggable={false}
        />
      ) : (
        <span
          className="taskbar-avatar-fallback"
          style={{ width: avatarSize, height: avatarSize, fontSize: Math.round(avatarSize * 0.45) }}
          aria-hidden="true"
        >
          {name.charAt(0).toUpperCase()}
        </span>
      )}
      <span className="taskbar-username">{name}</span>
    </div>
  );
}

function ClerkStartMenuUser({ avatarSize, className }: { avatarSize: number; className?: string }) {
  const { user } = useUser();
  const name = user?.fullName ?? user?.username ?? "User";
  return (
    <StartMenuUserView
      name={name}
      imageUrl={user?.imageUrl}
      avatarSize={avatarSize}
      className={className}
    />
  );
}

/** Avatar + display name for the start-menu header/footer. Falls back to a
    generic "User" during SSR and in self-hosted mode (mirrors MenuBar). */
export function StartMenuUser({ avatarSize, className }: { avatarSize: number; className?: string }) {
  const mounted = useIsClient();
  if (!mounted || isSelfHostedDocument()) {
    return <StartMenuUserView name="User" avatarSize={avatarSize} className={className} />;
  }
  return <ClerkStartMenuUser avatarSize={avatarSize} className={className} />;
}
