"use client";

import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import Image from "next/image";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

type NavigatorWithInstallSignals = Navigator & {
  standalone?: boolean;
  userAgentData?: {
    mobile?: boolean;
  };
};

const DISMISS_KEY = "matrix-os:pwa-install-dismissed";
const DISMISS_DAYS = 14;

const CONTAINER_STYLE: CSSProperties = {
  position: "fixed",
  left: "50%",
  bottom: "max(env(safe-area-inset-bottom, 0px), 16px)",
  transform: "translateX(-50%)",
  zIndex: 9999,
  width: "min(420px, calc(100vw - 24px))",
  background: "var(--card, #1c241b)",
  color: "var(--foreground, #f4ede0)",
  border: "1px solid var(--border, rgba(244,237,224,0.15))",
  borderRadius: 14,
  padding: "12px 14px",
  boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
  display: "flex",
  gap: 12,
  alignItems: "center",
};

const INSTALL_BUTTON_STYLE: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  padding: "8px 12px",
  borderRadius: 8,
  border: "none",
  background: "var(--primary, #c2703a)",
  color: "var(--primary-foreground, #fff)",
  cursor: "pointer",
};

const DISMISS_BUTTON_STYLE: CSSProperties = {
  fontSize: 16,
  padding: "6px 10px",
  borderRadius: 8,
  border: "1px solid var(--border, rgba(244,237,224,0.15))",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  opacity: 0.6,
};

function isDismissed(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const ts = Number(raw);
    if (!Number.isFinite(ts)) return false;
    const ageDays = (Date.now() - ts) / (1000 * 60 * 60 * 24);
    return ageDays < DISMISS_DAYS;
  } catch (err: unknown) {
    console.warn("[pwa] install dismiss check failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = window.navigator as NavigatorWithInstallSignals;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    nav.standalone === true
  );
}

function isIPadOSDesktopUserAgent(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as NavigatorWithInstallSignals;
  return nav.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1;
}

function isMobileInstallSurface(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as NavigatorWithInstallSignals;
  const mobileHint = nav.userAgentData?.mobile;
  if (mobileHint === true) return true;
  if (mobileHint === false) return false;

  const ua = nav.userAgent;
  if (isIPadOSDesktopUserAgent()) return true;
  return /iPad|iPhone|iPod|Android/.test(ua);
}

function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return (/iPad|iPhone|iPod/.test(ua) || isIPadOSDesktopUserAgent()) && !(window as { MSStream?: unknown }).MSStream;
}

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [iosHint, setIosHint] = useState(false);
  // Initial dismissed state is computed lazily so we never set it from inside
  // useEffect. true = hidden (SSR, already-installed, or user dismissed).
  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === "undefined") return true;
    if (isStandalone()) return true;
    if (!isMobileInstallSurface()) return true;
    return isDismissed();
  });

  // react-doctor-disable-next-line react-doctor/no-cascading-set-state -- not a synchronous cascade: setDeferred fires from the `beforeinstallprompt` event handler and setIosHint fires from a 4s timer; they run on independent async triggers, never sequentially within one render. A reducer would not change the event/timer sequencing.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (dismissed) return;
    if (!isMobileInstallSurface()) return;

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);

    if (isIOS()) {
      const t = setTimeout(() => setIosHint(true), 4000);
      return () => {
        clearTimeout(t);
        window.removeEventListener("beforeinstallprompt", handler);
      };
    }

    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, [dismissed]);

  const dismiss = () => {
    setDismissed(true);
    setDeferred(null);
    setIosHint(false);
    try {
      window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch (err: unknown) {
      console.warn("[pwa] failed to persist install dismissal:", err instanceof Error ? err.message : err);
    }
  };

  const install = async () => {
    if (!deferred) return;
    try {
      await deferred.prompt();
      const choice = await deferred.userChoice;
      dismiss();
      if (choice.outcome !== "accepted") {
        // user explicitly declined; nothing else to do
      }
    } catch (err: unknown) {
      console.warn("[pwa] install prompt failed:", err instanceof Error ? err.message : err);
      dismiss();
    }
  };

  if (dismissed || (!deferred && !iosHint)) return null;

  return (
    // react-doctor-disable-next-line react-doctor/prefer-tag-over-role, react-doctor/prefer-html-dialog -- native <dialog> defaults to display:none and requires imperative show()/showModal(); this is a persistently-rendered positioned banner (not a modal opened on demand), so role="dialog" preserves behavior without wiring up showModal().
    <div role="dialog" aria-label="Install Matrix OS" style={CONTAINER_STYLE}>
      <Image
        src="/icon-192.png"
        alt=""
        width={40}
        height={40}
        style={{ borderRadius: 10, flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>
          Install Matrix OS
        </div>
        <div style={{ fontSize: 12, opacity: 0.75, lineHeight: 1.35 }}>
          {iosHint
            ? "Tap Share, then \"Add to Home Screen\" to install."
            : "Add to your home screen for a faster, full-screen shell."}
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
        {deferred && (
          <button type="button" onClick={() => void install()} style={INSTALL_BUTTON_STYLE}>
            Install
          </button>
        )}
        <button type="button" aria-label="Dismiss" onClick={dismiss} style={DISMISS_BUTTON_STYLE}>
          ×
        </button>
      </div>
    </div>
  );
}
