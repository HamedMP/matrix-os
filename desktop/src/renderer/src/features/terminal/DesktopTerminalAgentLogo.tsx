import {
  TERMINAL_AGENT_OPTIONS,
  type TerminalAgentId,
} from "./terminal-agent-options";

export function DesktopTerminalAgentLogo({
  agent,
  compact = false,
  testIdPrefix = "desktop-terminal-agent-logo",
}: {
  agent: TerminalAgentId;
  compact?: boolean;
  testIdPrefix?: string;
}) {
  const option = TERMINAL_AGENT_OPTIONS.find((candidate) => candidate.id === agent);
  if (!option) return null;
  const containerSize = compact ? 18 : 22;
  const imageSize = compact ? 12 : 15;
  return (
    <span
      aria-hidden="true"
      data-testid={`${testIdPrefix}-${agent}`}
      className="inline-flex shrink-0 items-center justify-center overflow-hidden"
      style={{
        width: containerSize,
        height: containerSize,
        borderRadius: compact ? 5 : 7,
        background: option.color,
      }}
    >
      <img
        alt=""
        draggable={false}
        width={imageSize}
        height={imageSize}
        src={option.logoSrc}
        data-testid={`${testIdPrefix}-image-${agent}`}
        className="block object-contain"
        style={{ width: imageSize, height: imageSize }}
      />
    </span>
  );
}
