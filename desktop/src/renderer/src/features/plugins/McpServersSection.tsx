// MCP servers section of the Plugins hub. HONEST EMPTY STATE by design: no
// gateway route lists MCP servers today (the kernel wires mcpServers
// internally per agent run in packages/kernel/src/options.ts), so there is
// nothing real to render. The section says where MCP servers live and hands
// off to the canonical Terminal app for managing them.
import { Server } from "@renderer/lib/hugeicons";
import { Button } from "../../design/primitives";
import { useTabs } from "../../stores/tabs";
import { openPluginsTerminal } from "./open-plugins-terminal";

export function McpServersSection() {
  const openTab = useTabs((s) => s.openTab);

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
          <Button variant="primary" onClick={() => openPluginsTerminal(openTab)}>
            Open terminal
          </Button>
        </div>
      </div>
    </>
  );
}

export default McpServersSection;
