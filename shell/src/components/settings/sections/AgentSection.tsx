import { AgentRuntimePanel } from "./AgentRuntimePanel";
import type { TerminalLaunchAction } from "@/lib/terminal-launch";

export function AgentSection({
  onOpenTerminal,
}: {
  onOpenTerminal?: (action: TerminalLaunchAction) => void;
}) {
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6" data-provider-settings-adapter="legacy">
      <h2 className="text-lg font-semibold">Agents &amp; providers</h2>
      <AgentRuntimePanel onOpenTerminal={onOpenTerminal} />
    </div>
  );
}
