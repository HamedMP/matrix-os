// Static glyph per coding-agent provider kind. Uses bundled icons only —
// provider logos are never fetched from remote URLs.
import type { AgentProviderSummary } from "@matrix-os/contracts";
import { Code2, Cpu, MousePointer2, Pi, Sparkles, SquareTerminal } from "@renderer/lib/hugeicons";

const KIND_ICONS = {
  claude: Sparkles,
  codex: SquareTerminal,
  opencode: Code2,
  cursor: MousePointer2,
  pi: Pi,
  custom: Cpu,
} as const;

export function ProviderGlyph({
  kind,
  compact = false,
}: {
  kind: AgentProviderSummary["kind"];
  compact?: boolean;
}) {
  const Icon = KIND_ICONS[kind] ?? Cpu;
  return (
    <span
      aria-hidden
      className={compact
        ? "flex h-6 w-6 shrink-0 items-center justify-center"
        : "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"}
      style={{
        background: compact ? "transparent" : "var(--accent-muted)",
        color: compact ? "var(--text-secondary)" : "var(--accent)",
      }}
    >
      <Icon size={compact ? 15 : 16} />
    </span>
  );
}
