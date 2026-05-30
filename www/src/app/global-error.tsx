"use client";

import type { CSSProperties } from "react";
import { useEffect } from "react";
import { capturePostHogException } from "../lib/posthog-client";

const containerStyle: CSSProperties = {
  minHeight: "100vh",
  display: "grid",
  placeItems: "center",
  padding: 24,
  fontFamily: "system-ui, sans-serif",
};

const cardStyle: CSSProperties = { maxWidth: 360, textAlign: "center" };

const headingStyle: CSSProperties = { fontSize: 20, fontWeight: 600 };

const descriptionStyle: CSSProperties = {
  marginTop: 12,
  color: "#5f646d",
  fontSize: 14,
};

const buttonStyle: CSSProperties = {
  marginTop: 24,
  border: 0,
  borderRadius: 6,
  background: "#111827",
  color: "white",
  cursor: "pointer",
  fontSize: 14,
  fontWeight: 600,
  padding: "8px 14px",
};

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
        <div style={containerStyle}>
          <div style={cardStyle}>
            <h2 style={headingStyle}>Something went wrong</h2>
            <p style={descriptionStyle}>An unexpected error occurred. Please try again.</p>
            <button
              type="button"
              onClick={reset}
              style={buttonStyle}
            >
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
