import { ArrowLeft } from "lucide-react";
import { IconButton } from "../../design/primitives";
import { useUi } from "../../stores/ui";
import TerminalView from "../terminal/TerminalView";

export default function StandaloneSession({ sessionName }: { sessionName: string }) {
  const navigate = useUi((s) => s.navigate);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
      >
        <IconButton label="Back to sessions" onClick={() => navigate({ kind: "sessions" })}>
          <ArrowLeft size={15} />
        </IconButton>
        <span className="truncate font-mono text-sm" style={{ color: "var(--text-primary)" }}>
          {sessionName}
        </span>
      </div>
      <TerminalView sessionName={sessionName} />
    </div>
  );
}
