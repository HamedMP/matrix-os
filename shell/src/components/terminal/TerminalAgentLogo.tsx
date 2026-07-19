"use client";

import Image from "next/image";
import type { CSSProperties } from "react";
import { TERMINAL_AGENT_OPTIONS, type TerminalAgentId } from "./terminal-agent-options";

const AGENT_LOGO_BASE_STYLE: CSSProperties = {
  alignItems: "center",
  border: "1px solid rgba(255, 255, 255, 0.56)",
  boxShadow: "0 1px 0 rgba(255, 255, 255, 0.36) inset, 0 4px 9px rgba(49, 54, 45, 0.14)",
  boxSizing: "border-box",
  color: "#FFFDF7",
  display: "inline-flex",
  flexShrink: 0,
  justifyContent: "center",
  overflow: "hidden",
};

export function TerminalAgentLogo({
  agent,
  compact = false,
  muted = false,
  testIdPrefix = "terminal-agent-logo",
}: {
  agent: TerminalAgentId;
  compact?: boolean;
  muted?: boolean;
  testIdPrefix?: string;
}) {
  const option = TERMINAL_AGENT_OPTIONS.find((candidate) => candidate.id === agent);
  if (!option) return null;
  const containerSize = compact ? 16 : 22;
  const imageSize = compact ? 11 : 15;

  return (
    <span
      aria-hidden="true"
      data-testid={`${testIdPrefix}-${option.id}`}
      style={{
        ...AGENT_LOGO_BASE_STYLE,
        background: option.color,
        borderRadius: compact ? 4 : 7,
        flexBasis: containerSize,
        height: containerSize,
        opacity: muted ? 0.86 : 1,
        width: containerSize,
      }}
    >
      <Image
        alt=""
        data-testid={`${testIdPrefix}-image-${option.id}`}
        draggable={false}
        height={imageSize}
        loading="eager"
        src={option.logoSrc}
        style={{ display: "block", height: imageSize, objectFit: "contain", width: imageSize }}
        width={imageSize}
        unoptimized
      />
    </span>
  );
}
