"use client";

import type { ReactNode } from "react";
import { CopyCommand } from "./CopyCommand.js";

export const CLI_BREW_INSTALL_COMMAND = "brew install finnaai/tap/matrix";
export const CLI_NPM_INSTALL_COMMAND = "npm install -g @finnaai/matrix";
const MCP_URL = "https://api.matrix-os.com/mcp";
const DOCS_URL = "https://matrix-os.com/docs/mcp";

function GuideLink({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer" className="rounded underline underline-offset-4 focus-visible:outline focus-visible:outline-2">{children}</a>;
}

export function MatrixCliSetup() {
  return (
    <section aria-label="CLI setup" className="flex flex-col gap-3">
      <h3 className="text-lg font-semibold">CLI</h3>
      <p className="text-sm">Control your Matrix computer from your local terminal. Choose one installer; Node.js 24+ is required for npm.</p>
      <CopyCommand title="Homebrew" command={CLI_BREW_INSTALL_COMMAND} testId="plugins-cli-copy-brew" />
      <CopyCommand title="npm" command={CLI_NPM_INSTALL_COMMAND} testId="plugins-cli-copy-npm" />
      <CopyCommand title="CLI sign-in" command={"matrix login\nmatrix status"} />
    </section>
  );
}

export function MatrixLocalSetup() {
  return (
    <div className="flex min-w-0 flex-col gap-7" style={{ color: "var(--text-primary, var(--foreground))" }}>
      <header className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold tracking-tight">Matrix CLI &amp; MCP</h2>
        <p className="text-sm">Connect the tools on your local computer to your Matrix computer.</p>
        <p className="text-sm">Run setup commands on your local computer, not in your Matrix VPS. Copying does not install anything. On a phone, open this guide on the computer you want to set up.</p>
      </header>
      <MatrixCliSetup />
      <section aria-label="MCP setup" className="flex flex-col gap-3">
        <h3 className="text-lg font-semibold">MCP</h3>
        <p className="text-sm">Let your local coding agent run commands, manage terminals and files, and read chats on your selected Matrix computer. No Matrix CLI installation is needed for Streamable HTTP.</p>
        <div className="rounded-lg border p-3 text-sm" style={{ borderColor: "var(--border-subtle, var(--border))", background: "var(--bg-surface, var(--card))" }}>
          <strong>Hosted setup requires activation.</strong> Availability is not checked here. The operator must enable hosted MCP and verify browser OAuth before these connections work. A 503 means the service is unavailable; CLI sign-in cannot fix it.
        </div>
        <CopyCommand title="MCP URL" command={MCP_URL} />
        <p className="text-sm">Choose direct MCP below for tools only, or the plugin in the next section for tools plus skills. Do not install both connections in the same client.</p>
        <CopyCommand title="Codex MCP" command={`codex mcp add matrix --url ${MCP_URL}\ncodex mcp login matrix`} />
        <CopyCommand title="Claude Code MCP" command={`claude mcp add --transport http --scope user matrix ${MCP_URL}`} />
        <p className="text-sm">In Claude Code, open <code>/mcp</code>, select Matrix, and sign in through your browser.</p>
        <div className="flex flex-wrap gap-4 text-sm">
          <GuideLink href={`${DOCS_URL}#cursor`}>Set up Cursor</GuideLink>
          <GuideLink href={`${DOCS_URL}#vs-code--copilot`}>Set up VS Code</GuideLink>
          <GuideLink href={DOCS_URL}>MCP documentation</GuideLink>
        </div>
        <p className="text-xs">These guides open in your browser and include native install links. Review the connection and approve browser consent yourself.</p>
      </section>
      <section aria-label="Local skills setup" className="flex flex-col gap-3">
        <h3 className="text-lg font-semibold">Skills &amp; plugins</h3>
        <p className="text-sm">The Matrix OS plugin bundles MCP with setup, cloud-work, and GitHub-project workflow skills for your local coding agent. These are separate from skills installed on your Matrix VPS. Hosted activation is required for the bundled tools.</p>
        <CopyCommand title="Codex plugin" command="codex plugin marketplace add HamedMP/matrix-os" />
        <p className="text-sm">Run this in your local terminal. In Codex, open <code>/plugins</code>, select the Matrix OS marketplace, and install <code>matrix-os</code>.</p>
        <CopyCommand title="Claude Code plugin" command={"/plugin marketplace add HamedMP/matrix-os\n/plugin install matrix-os@matrix-os"} />
        <p className="text-sm">Run these slash commands inside Claude Code, not your shell. Start a new session and authenticate the bundled MCP connection. Matrix’s own marketplace is not an official directory listing.</p>
      </section>
      <section aria-label="Connection permissions" className="flex flex-col gap-2 border-t pt-4 text-sm">
        <h3 className="font-semibold">Only connect clients you trust</h3>
        <p>The <code>matrix:computer</code> scope permits arbitrary commands, file changes, terminal control, and chat reads on computers your account can access. Never paste tokens into configuration or chat.</p>
        <p>MCP does not disable your coding agent’s local shell. Configure its permissions separately if you want remote-only execution. This page cannot detect or verify local installations.</p>
      </section>
    </div>
  );
}
