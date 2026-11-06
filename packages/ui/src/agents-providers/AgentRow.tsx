import type { ProviderHarnessKind } from "@matrix-os/contracts";
import type { ReactNode } from "react";
import { codingAgentArtworkSrc, settingsHarnessArtworkSrc, CODING_AGENT_ARTWORK } from "../coding-agent-artwork.js";
import { ProviderAccordion } from "./ProviderAccordion.js";

/** Settings retains the shipped upstream artwork, per the reviewed design override. */
export function HarnessIcon({ harness }: { harness: ProviderHarnessKind }) {
  const src = harness === "claude" || harness === "codex" ? settingsHarnessArtworkSrc(harness) : codingAgentArtworkSrc(CODING_AGENT_ARTWORK[harness].src);
  const size = harness === "claude" ? 22 : harness === "codex" ? 20 : 24;
  return (
    <span
      className="matrix-ap-agent-logo"
      // White upstream marks retain the canonical artwork background in both appearances.
      style={harness === "opencode" || harness === "pi" ? { background: CODING_AGENT_ARTWORK[harness].background } : undefined}
      aria-hidden="true"
    >
      <img
        src={src}
        alt=""
        className={harness === "claude" ? "matrix-ap-claude-logo" : harness === "codex" ? "matrix-ap-openai-logo" : "matrix-ap-upstream-logo"}
        width={size}
        height={size}
        draggable={false}
        loading="eager"
      />
    </span>
  );
}

function RowChevron({ expanded }: { expanded: boolean }) {
  // Same Hugeicons ChevronDown geometry used by Settings ChannelCard/SkillsSection.
  return <span className="matrix-ap-chevron" data-expanded={expanded} aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M18 9.00005C18 9.00005 13.5811 15 12 15C10.4188 15 6 9 6 9" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
    </svg>
  </span>;
}

/**
 * One agent in Settings > Agents & providers: logo, name, status chip and chevron, with its details
 * below. Get started's coding agents screen renders the same row (spec 636).
 */
export function AgentRow({ id, harness, name, status, accent, expanded, onToggle, children }: {
  id: string;
  harness: ProviderHarnessKind;
  name: string;
  status: string;
  /** The harness instance's accent; rows for agents without an instance have none. */
  accent?: string;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const detailsId = `matrix-ap-details-${id}`;
  return (
    <div className="matrix-ap-agent-row">
      <div className="matrix-ap-agent-row-head">
        <button
          type="button"
          className="matrix-ap-rail-item"
          aria-expanded={expanded}
          aria-controls={detailsId}
          id={`${detailsId}-trigger`}
          onClick={onToggle}
        >
          <span className="matrix-ap-harness-mark" data-accent={accent} aria-hidden="true">
            <HarnessIcon harness={harness} />
          </span>
          <span className="matrix-ap-rail-copy">
            <span className="matrix-ap-rail-name">{name}</span>
          </span>
          <span className="matrix-ap-status-chip" data-state={status.toLowerCase().replaceAll(" ", "-")}>
            <i aria-hidden="true" />
            {status}
          </span>
          <RowChevron expanded={expanded} />
        </button>
      </div>
      <ProviderAccordion id={detailsId} expanded={expanded}>
        {children}
      </ProviderAccordion>
    </div>
  );
}
