// MCP servers section of the Plugins hub. HONEST EMPTY STATE by design: no
// gateway route lists MCP servers today (the kernel wires mcpServers
// internally per agent run in packages/kernel/src/options.ts), so there is
// nothing real to render. The section says where MCP servers live and hands
// off to the canonical terminal session for managing them.
import { Server } from "lucide-react";
import { useState } from "react";
import { categoryMessage } from "../../../../shared/app-error";
import { Button } from "../../design/primitives";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";
import { openPluginsTerminal } from "./open-plugins-terminal";

const MCP_TERMINAL_SESSION = "plugins-mcp";

export function McpServersSection() {
  const api = useConnection((s) => s.api);
  const openTab = useTabs((s) => s.openTab);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleOpenTerminal = async (): Promise<void> => {
    if (busy) return;
    if (!api) {
      setErrorMessage(categoryMessage("misconfigured"));
      return;
    }
    setBusy(true);
    setErrorMessage(null);
    const opened = await openPluginsTerminal(api, openTab, {
      sessionName: MCP_TERMINAL_SESSION,
      title: "MCP servers",
    });
    setBusy(false);
    if (!opened) setErrorMessage(categoryMessage("server"));
  };

  return (
    <>
      <div className="mb-5 flex flex-col gap-1">
        <h3 className="text-xl font-semibold tracking-tight" style={{ color: "var(--text-primary)" }}>
          MCP servers
        </h3>
        <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
          Model Context Protocol servers give your agent extra tools.
        </p>
      </div>

      <div
        className="flex flex-col items-center gap-2 rounded-xl border p-8 text-center"
        style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
      >
        <Server size={20} style={{ color: "var(--text-tertiary)" }} />
        <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
          MCP servers are configured on your Matrix computer
        </p>
        <p className="max-w-[360px] text-xs" style={{ color: "var(--text-tertiary)" }}>
          There is no server list to show here yet. Open a terminal on your computer to add or
          edit MCP servers in your agent configuration.
        </p>
        <div className="mt-2">
          <Button variant="primary" disabled={busy} onClick={() => void handleOpenTerminal()}>
            {busy ? "Opening…" : "Open terminal"}
          </Button>
        </div>
        {errorMessage ? (
          <p className="text-xs" style={{ color: "var(--danger)" }}>{errorMessage}</p>
        ) : null}
      </div>
    </>
  );
}

export default McpServersSection;
