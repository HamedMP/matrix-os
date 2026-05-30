"use client";

import { useEffect, useMemo, useState } from "react";
import { createErrorId, describeUnknownError } from "../lib/error-boundary-utils";
import { capturePostHogException, reportClientError } from "../lib/posthog-client";

export default function GlobalError({
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
      source: "shell-global-error-boundary",
      digest: error.digest,
      errorId,
    });
    reportClientError(error, {
      source: "shell-global-error-boundary",
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
      console.warn("[global-error-boundary] Failed to copy error ID:", describeUnknownError(err));
      setCopied(false);
    }
  }

  return (
    <html>
      <body>
        <div
          style={{
            alignItems: "center",
            background: "#f6f4ec",
            boxSizing: "border-box",
            color: "#32352E",
            display: "flex",
            fontFamily: "Inter, system-ui, sans-serif",
            height: "100vh",
            justifyContent: "center",
            padding: 24,
            width: "100vw",
          }}
        >
          <div
            style={{
              alignItems: "center",
              background: "rgba(255,255,255,0.82)",
              border: "1px solid rgba(67,78,63,0.12)",
              borderRadius: 28,
              boxShadow: "0 24px 80px rgba(67,78,63,0.16)",
              boxSizing: "border-box",
              display: "flex",
              flexDirection: "column",
              maxWidth: 448,
              padding: 32,
              textAlign: "center",
              width: "100%",
            }}
          >
            <div
              style={{
                alignItems: "center",
                background: "#fbf7ed",
                border: "1px solid rgba(67,78,63,0.15)",
                borderRadius: 18,
                boxShadow: "0 18px 50px rgba(83,68,48,0.12)",
                display: "flex",
                height: 64,
                justifyContent: "center",
                width: 64,
              }}
            >
              <div
                aria-hidden="true"
                style={{
                  background: "#32352E",
                  height: 36,
                  WebkitMaskImage: "url('/matrix-logo.svg')",
                  WebkitMaskPosition: "center",
                  WebkitMaskRepeat: "no-repeat",
                  WebkitMaskSize: "contain",
                  maskImage: "url('/matrix-logo.svg')",
                  maskPosition: "center",
                  maskRepeat: "no-repeat",
                  maskSize: "contain",
                  width: 36,
                }}
              />
            </div>
            <p
              style={{
                color: "rgba(67,78,63,0.55)",
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: "0.2em",
                margin: "24px 0 0",
                textTransform: "uppercase",
              }}
            >
              Matrix OS
            </p>
            <h2 style={{ fontSize: 30, fontWeight: 650, letterSpacing: "-0.01em", lineHeight: 1.08, margin: "12px 0 0" }}>
              Something went wrong
            </h2>
            <p style={{ color: "rgba(67,78,63,0.65)", fontSize: 14, lineHeight: 1.6, margin: "12px 0 0", maxWidth: 360 }}>
              Matrix hit an unexpected state. Try again and we will reload the shell.
            </p>
            <button
              type="button"
              onClick={copyErrorId}
              aria-label={`Copy error ID ${errorId}`}
              style={{
                alignItems: "center",
                background: "#fbf7ed",
                border: "1px solid rgba(67,78,63,0.12)",
                borderRadius: 12,
                color: "rgba(67,78,63,0.72)",
                cursor: "pointer",
                display: "inline-flex",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 12,
                gap: 8,
                marginTop: 20,
                maxWidth: "100%",
                padding: "8px 12px",
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                Error ID: {errorId}
              </span>
              <span style={{ color: "#D06F25", fontFamily: "Inter, system-ui, sans-serif", fontSize: 11, fontWeight: 700 }}>
                {copied ? "Copied" : "Copy"}
              </span>
            </button>
            <button
              type="button"
              onClick={reset}
              style={{
                background: "#434E3F",
                border: "none",
                borderRadius: 12,
                color: "#FAFAF5",
                cursor: "pointer",
                fontSize: 14,
                fontWeight: 700,
                height: 44,
                marginTop: 24,
                padding: "0 20px",
              }}
            >
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
