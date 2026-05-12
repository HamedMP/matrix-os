"use client";

import { useEffect } from "react";
import { capturePostHogException } from "../lib/posthog-client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    capturePostHogException(error, {
      source: "www-global-error-boundary",
      digest: error.digest,
    });
  }, [error]);

  return (
    <html lang="en">
      <body>
        <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, fontFamily: "system-ui, sans-serif" }}>
          <div style={{ maxWidth: 360, textAlign: "center" }}>
            <h2 style={{ fontSize: 20, fontWeight: 600 }}>Something went wrong</h2>
            <p style={{ marginTop: 12, color: "#5f646d", fontSize: 14 }}>An unexpected error occurred. Please try again.</p>
            <button
              onClick={reset}
              style={{ marginTop: 24, border: 0, borderRadius: 6, background: "#111827", color: "white", cursor: "pointer", fontSize: 14, fontWeight: 600, padding: "8px 14px" }}
            >
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
