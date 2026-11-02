"use client";

import { useSyncExternalStore } from "react";
import { STALE_BUNDLE_RECOVERY_STORAGE_KEY } from "../../lib/stale-bundle-recovery";

const FIXTURE_RUNTIME = "webpack-8e8abca4e92ce4e9.js";
const subscribe = () => () => undefined;

export default function ErrorPreviewCrash({ kind }: { kind: "generic" | "stale-bundle" }) {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  if (!hydrated) return null;

  if (kind === "stale-bundle") {
    if (hasRecoveredFixture()) {
      return (
        <main className="flex min-h-screen items-center justify-center bg-[#f6f4ec] px-6 text-deep">
          <section className="w-full max-w-md rounded-[28px] border border-forest/12 bg-white/80 p-8 text-center shadow-[0_24px_80px_rgba(67,78,63,0.16)]">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-forest/55">Matrix OS</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight">Stale bundle recovered</h1>
            <p className="mt-3 text-sm leading-6 text-forest/65">
              Web Desktop reloaded once and moved this tab onto the latest shell.
            </p>
            <p className="mt-5 font-mono text-xs text-forest/60">{FIXTURE_RUNTIME}</p>
          </section>
        </main>
      );
    }

    const error = new Error(
      "Loading chunk 4913 failed. (timeout: /__platform-shell/_next/static/chunks/4913-33f6c7c99102b8d7.js)",
    );
    error.name = "ChunkLoadError";
    error.stack = `ChunkLoadError: ${error.message}\n    at /__platform-shell/_next/static/chunks/${FIXTURE_RUNTIME}:1:4021`;
    throw error;
  }

  throw new Error("Matrix OS error preview: verify PostHog error tracking");
}

function hasRecoveredFixture(): boolean {
  try {
    const value = window.sessionStorage.getItem(STALE_BUNDLE_RECOVERY_STORAGE_KEY);
    if (!value) return false;
    const claim: unknown = JSON.parse(value);
    return Boolean(
      claim
      && typeof claim === "object"
      && "fingerprint" in claim
      && claim.fingerprint === FIXTURE_RUNTIME,
    );
  } catch (err: unknown) {
    console.warn("[error-preview] Failed to read recovery claim:", err instanceof Error ? err.name : typeof err);
    return false;
  }
}
