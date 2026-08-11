"use client";

import type { CSSProperties } from "react";

import type { TerminalAuthLink } from "./terminal-auth-links";

const BASE_STYLE: CSSProperties = {
  position: "absolute",
  top: 8,
  left: 8,
  right: 8,
  zIndex: 20,
  color: "#fff",
  borderRadius: 8,
  padding: "8px 12px",
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 13,
  boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
};

const ACTION_STYLE: CSSProperties = {
  background: "rgba(255,255,255,0.2)",
  border: "1px solid rgba(255,255,255,0.3)",
  color: "#fff",
  borderRadius: 6,
  padding: "4px 12px",
  cursor: "pointer",
  fontSize: 13,
  whiteSpace: "nowrap",
};

interface TerminalAuthBannerProps {
  link: TerminalAuthLink;
  color: string;
  onDismiss: () => void;
}

function fallbackCopy(text: string): void {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  try {
    textarea.select();
    document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

function tryFallbackCopy(url: string): void {
  try {
    fallbackCopy(url);
  } catch (err: unknown) {
    console.warn("Terminal auth URL fallback copy failed:", err instanceof Error ? err.message : err);
  }
}

function copyAuthUrl(url: string): void {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).catch((err: unknown) => {
      console.warn("Terminal auth URL clipboard write failed, using fallback:", err instanceof Error ? err.message : err);
      tryFallbackCopy(url);
    });
    return;
  }
  tryFallbackCopy(url);
}

export function TerminalAuthBanner({ link, color, onDismiss }: TerminalAuthBannerProps) {
  return (
    <div role="status" aria-live="polite" style={{ ...BASE_STYLE, background: color }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div>{link.providerLabel} login required</div>
        <div style={{ fontSize: 12, opacity: 0.85 }}>
          Detected from terminal output. Terminal apps can spoof this. Only continue if you initiated {link.providerLabel} login.
        </div>
        <div
          style={{
            fontSize: 12,
            opacity: 0.9,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={link.url}
        >
          {link.url}
        </div>
      </div>
      <button
        type="button"
        onClick={() => window.open(link.url, "_blank", "noopener,noreferrer")}
        style={ACTION_STYLE}
      >
        Open login
      </button>
      <button type="button" onClick={() => copyAuthUrl(link.url)} style={ACTION_STYLE}>
        Copy URL
      </button>
      <button
        type="button"
        aria-label="Dismiss login link"
        onClick={onDismiss}
        style={{
          background: "none",
          border: "none",
          color: "rgba(255,255,255,0.7)",
          cursor: "pointer",
          fontSize: 16,
          padding: "0 4px",
          lineHeight: 1,
        }}
      >
        x
      </button>
    </div>
  );
}
