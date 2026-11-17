"use client";

import type { CSSProperties, ReactNode } from "react";
import { useState } from "react";
import { CODING_AGENT_ARTWORK, codingAgentArtworkSrc } from "./coding-agent-artwork.js";
import type { AgentLogoKind } from "./agent-logo-kind.js";

/** Crisp vector marks on a light tile where we ship them; raster marks sit inside
 * their brand tile with padding instead of being cropped to fill it. */
const LOGO: Record<AgentLogoKind, { src: string; tile: string; inset: number; border?: boolean }> = {
  claude: { src: "/agents/settings/claude.svg", tile: "#FFFFFF", inset: 0.2, border: true },
  codex: { src: "/agents/settings/openai.svg", tile: "#FFFFFF", inset: 0.2, border: true },
  hermes: { src: CODING_AGENT_ARTWORK.hermes.src, tile: CODING_AGENT_ARTWORK.hermes.background, inset: 0.12, border: true },
  openclaw: { src: CODING_AGENT_ARTWORK.openclaw.src, tile: CODING_AGENT_ARTWORK.openclaw.background, inset: 0.16 },
  opencode: { src: CODING_AGENT_ARTWORK.opencode.src, tile: CODING_AGENT_ARTWORK.opencode.background, inset: 0.2 },
  pi: { src: CODING_AGENT_ARTWORK.pi.src, tile: CODING_AGENT_ARTWORK.pi.background, inset: 0.16 },
};

/** One agent mark used by every agent list, so the inbox and project rows always match. */
export function AgentLogo({ kind, label, size = 30, dimmed = false, badge }: {
  kind?: AgentLogoKind; label: string; size?: number; dimmed?: boolean; badge?: ReactNode;
}) {
  const logo = kind ? LOGO[kind] : undefined;
  const src = logo ? codingAgentArtworkSrc(logo.src) : null;
  // Keyed by source, so a row that changes agent retries the new image.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = src !== null && failedSrc === src;
  const pad = logo ? Math.round(size * logo.inset) : 0;
  const tile: CSSProperties = {
    position: "relative", display: "grid", placeItems: "center", flex: "0 0 auto",
    width: size, height: size, borderRadius: Math.round(size * 0.27),
    background: logo && !failed ? logo.tile : "var(--bg-sunken, var(--muted))",
    boxShadow: logo?.border && !failed ? "inset 0 0 0 1px var(--border-subtle, rgba(0,0,0,0.08))" : undefined,
    color: "var(--text-secondary, var(--foreground))", fontSize: Math.round(size * 0.38), fontWeight: 600,
    opacity: dimmed ? 0.8 : 1,
  };
  return <span aria-hidden="true" style={tile}>
    {logo && !failed
      ? <img src={src ?? undefined} alt="" draggable={false} onError={() => setFailedSrc(src)}
        style={{ width: size - pad * 2, height: size - pad * 2, objectFit: "contain", display: "block" }} />
      : label.trim().slice(0, 1).toUpperCase() || "·"}
    {badge}
  </span>;
}
