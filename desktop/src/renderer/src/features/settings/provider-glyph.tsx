// Static glyph per coding-agent provider kind. Uses bundled lucide icons only
// — provider logos are never fetched from remote URLs.
import type { AgentProviderSummary } from "@matrix-os/contracts";
import { Code2, Cpu, MousePointer2, Pi, Sparkles, SquareTerminal } from "lucide-react";

const KIND_ICONS = {
  claude: Sparkles,
  codex: SquareTerminal,
  opencode: Code2,
  cursor: MousePointer2,
  pi: Pi,
  custom: Cpu,
} as const;

export function ProviderGlyph({ kind }: { kind: AgentProviderSummary["kind"] }) {
  const Icon = KIND_ICONS[kind] ?? Cpu;
  return (
    <span
      aria-hidden
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
      style={{ background: "var(--accent-muted)", color: "var(--accent)" }}
    >
      <Icon size={16} />
    </span>
  );
}
