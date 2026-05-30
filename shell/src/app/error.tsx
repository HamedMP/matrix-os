"use client";

import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import { createErrorId, describeUnknownError } from "../lib/error-boundary-utils";
import { capturePostHogException, reportClientError } from "../lib/posthog-client";

const LOGO_MARK_STYLE: CSSProperties = {
  WebkitMaskImage: "url('/matrix-logo.svg')",
  WebkitMaskPosition: "center",
  WebkitMaskRepeat: "no-repeat",
  WebkitMaskSize: "contain",
  maskImage: "url('/matrix-logo.svg')",
  maskPosition: "center",
  maskRepeat: "no-repeat",
  maskSize: "contain",
};

function MatrixLogoMark() {
  return (
    <div className="relative flex size-16 items-center justify-center rounded-2xl border border-forest/15 bg-[#fbf7ed] shadow-[0_18px_50px_rgba(83,68,48,0.12)]">
      <div className="size-9 bg-deep" aria-hidden="true" style={LOGO_MARK_STYLE} />
    </div>
  );
}

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const errorId = useMemo(() => createErrorId(error), [error]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    capturePostHogException(error, {
      source: "shell-error-boundary",
      digest: error.digest,
      errorId,
    });
    reportClientError(error, {
      source: "shell-error-boundary",
      digest: error.digest,
      errorId,
    });
  }, [error, errorId]);

  async function copyErrorId() {
    try {
      await navigator.clipboard.writeText(errorId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (err: unknown) {
      console.warn("[error-boundary] Failed to copy error ID:", describeUnknownError(err));
      setCopied(false);
    }
  }

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-[#f6f4ec] px-6 text-deep">
      <div className="flex w-full max-w-md flex-col items-center rounded-[28px] border border-forest/12 bg-white/80 p-8 text-center shadow-[0_24px_80px_rgba(67,78,63,0.16)] backdrop-blur-xl">
        <MatrixLogoMark />
        <p className="mt-6 text-xs font-semibold uppercase tracking-[0.2em] text-forest/55">
          Matrix OS
        </p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-deep">
          Something went wrong
        </h2>
        <p className="mt-3 max-w-sm text-sm leading-6 text-forest/65">
          Matrix hit an unexpected state. Try again and we will reload the shell.
        </p>
        <button
          type="button"
          onClick={copyErrorId}
          className="mt-5 inline-flex max-w-full items-center gap-2 rounded-xl border border-forest/12 bg-[#fbf7ed] px-3 py-2 font-mono text-xs text-forest/70 transition-colors hover:border-ember/35 hover:text-deep"
          aria-label={`Copy error ID ${errorId}`}
        >
          <span className="truncate">Error ID: {errorId}</span>
          <span className="font-sans text-[11px] font-semibold text-ember">
            {copied ? "Copied" : "Copy"}
          </span>
        </button>
        <button
          type="button"
          onClick={reset}
          className="mt-6 inline-flex h-11 items-center justify-center rounded-xl bg-forest px-5 text-sm font-semibold text-ember-foreground transition-colors hover:bg-deep"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
