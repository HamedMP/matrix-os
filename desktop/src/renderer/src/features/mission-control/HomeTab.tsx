import { Kanban, Maximize2, Sparkles } from "lucide-react";
import { Button } from "../../design/primitives";
import { invoke } from "../../lib/operator";
import { useBoard } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";
import { EmbedHost } from "../embeds";

// Home previews the user's live hosted Matrix OS shell (Canvas) with a thin
// action bar on top. The shell embed authenticates via session handoff.
export default function HomeTab({ active = true }: { active?: boolean }) {
  const status = useConnection((s) => s.status);
  const handle = useConnection((s) => s.handle);
  const platformHost = useConnection((s) => s.platformHost);
  const projects = useBoard((s) => s.projects);
  const openTab = useTabs((s) => s.openTab);
  const signedIn = status === "signed-in";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="flex shrink-0 items-center gap-3 border-b px-5 py-3"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            {handle ? `Welcome back, @${handle}` : "Welcome to Matrix OS"}
          </span>
          <span className="truncate text-xs" style={{ color: "var(--text-tertiary)" }}>
            Your cloud computer · live preview of your shell
          </span>
        </div>
        <Button variant="subtle" onClick={() => openTab({ kind: "chat", title: "Hermes", closable: false })}>
          <Sparkles size={14} />
          Ask Hermes
        </Button>
        {projects[0] ? (
          <Button
            variant="subtle"
            onClick={() => openTab({ kind: "board", projectSlug: projects[0]!.slug, title: projects[0]!.name || projects[0]!.slug })}
          >
            <Kanban size={14} />
            Board
          </Button>
        ) : null}
        <Button variant="primary" onClick={() => void invoke("shell:open-external", { url: platformHost.startsWith("https://") ? platformHost : "https://app.matrix-os.com" })}>
          <Maximize2 size={13} />
          Open in browser
        </Button>
      </div>
      {signedIn ? <EmbedHost kind="hosted-shell" active={active} /> : null}
    </div>
  );
}
