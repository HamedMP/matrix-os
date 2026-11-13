"use client";

import { MCP_SERVICE_MARKS } from "./mcp-service-marks.js";

export interface McpServiceLogoProps {
  /** Remote MCP catalog id; custom servers have none and get a neutral monogram. */
  presetId?: string;
  name: string;
  size?: number;
  className?: string;
}

const tile = (size: number) => ({
  width: size,
  height: size,
  borderRadius: Math.round(size * 0.26),
});

/**
 * A service's brand mark on a light app-icon tile, so dark marks (Notion,
 * Vercel, GitHub) stay legible in dark themes too. Decorative: the service
 * name is always rendered next to it.
 */
export function McpServiceLogo({ presetId, name, size = 40, className }: McpServiceLogoProps) {
  const mark = presetId && Object.hasOwn(MCP_SERVICE_MARKS, presetId) ? MCP_SERVICE_MARKS[presetId] : undefined;
  const glyph = Math.round(size * 0.56);
  const base = `flex shrink-0 select-none items-center justify-center overflow-hidden ${className ?? ""}`;

  if (!mark) {
    return (
      <span aria-hidden="true" data-mcp-logo="fallback" className={base}
        style={{ ...tile(size), background: "var(--bg-surface-hover, var(--muted))", color: "var(--text-secondary, var(--muted-foreground))", fontSize: Math.round(size * 0.4), fontWeight: 600 }}>
        {name.trim().charAt(0).toUpperCase() || "?"}
      </span>
    );
  }

  if (mark.kind === "monogram") {
    return (
      <span aria-hidden="true" data-mcp-logo={presetId} className={base}
        style={{ ...tile(size), background: mark.color, color: mark.foreground, fontSize: Math.round(size * (mark.text.length > 1 ? 0.34 : 0.44)), fontWeight: 700, letterSpacing: "-0.02em" }}>
        {mark.text}
      </span>
    );
  }

  return (
    <span aria-hidden="true" data-mcp-logo={presetId} className={base}
      style={{ ...tile(size), background: "#FFFFFF", boxShadow: "inset 0 0 0 1px rgba(15, 23, 42, 0.08)" }}>
      {mark.kind === "monday" ? (
        <svg width={glyph} height={glyph} viewBox="0 0 24 24" focusable="false">
          <rect x="1.2" y="6.4" width="4.6" height="12.4" rx="2.3" fill="#FF3D57" transform="rotate(32 3.5 12.6)" />
          <rect x="8.4" y="6.4" width="4.6" height="12.4" rx="2.3" fill="#FFCB00" transform="rotate(32 10.7 12.6)" />
          <circle cx="19.4" cy="16.2" r="2.6" fill="#00CA72" />
        </svg>
      ) : (
        <svg width={glyph} height={glyph} viewBox="0 0 24 24" focusable="false">
          <path d={mark.path} fill={mark.color} />
        </svg>
      )}
    </span>
  );
}

/** Overlapping logos for a set of connected services (endpoint card summary). */
export function McpServiceLogoStack({ services, max = 6, size = 28 }: {
  services: ReadonlyArray<{ presetId?: string; name: string }>;
  max?: number;
  size?: number;
}) {
  const shown = services.slice(0, max);
  const extra = services.length - shown.length;
  return (
    <span className="flex items-center" aria-hidden="true">
      {shown.map((service, index) => (
        <span key={`${service.presetId ?? "custom"}:${service.name}:${index}`} className="rounded-[30%]"
          style={{ marginLeft: index === 0 ? 0 : -Math.round(size * 0.28), boxShadow: "0 0 0 2px var(--bg-surface, var(--card, #fff))", borderRadius: Math.round(size * 0.26) }}>
          <McpServiceLogo presetId={service.presetId} name={service.name} size={size} />
        </span>
      ))}
      {extra > 0 ? (
        <span className="flex items-center justify-center text-[11px] font-semibold"
          style={{ ...tile(size), marginLeft: -Math.round(size * 0.28), background: "var(--bg-surface-hover, var(--muted))", color: "var(--text-secondary, var(--muted-foreground))", boxShadow: "0 0 0 2px var(--bg-surface, var(--card, #fff))" }}>
          +{extra}
        </span>
      ) : null}
    </span>
  );
}
