import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_INSTALLS, PACKAGE_MANAGER_INSTALLS, terminalNpmInstallCommand } from "./agent-install-matrix";
import { CODEX_VERIFIED_NPM_PACKAGE } from "../../packages/contracts/src/index.js";
import { TERMINAL_AGENT_OPTIONS, terminalAgentCreateOptions, terminalAgentInstallCommand, terminalAgentVisibleInstallCommand, terminalTabLaunchFields }
  from "../../packages/ui/src/terminal/agent-launch.js";

const root = process.cwd();

describe("agent CLI install matrix", () => {
  it("covers the four terminal agent menu agents", () => {
    expect(AGENT_INSTALLS.map((agent) => agent.id)).toEqual(["claude", "codex", "opencode", "pi"]);
    expect(AGENT_INSTALLS.map((agent) => agent.binary)).toEqual(["claude", "codex", "opencode", "pi"]);
  });

  it("keeps Terminal install rows on direct npm commands with the Matrix node prefix fallback", () => {
    const terminalSidebar = readFileSync(join(root, "shell/src/components/terminal/TerminalSidebar.tsx"), "utf8");
    const mobileTerminalControls = readFileSync(join(root, "shell/src/components/terminal/MobileTerminalControls.tsx"), "utf8");

    expect(terminalSidebar).toContain("terminalAgentCreateOptions(option, action)");
    expect(mobileTerminalControls).toContain("terminalAgentCreateOptions(option, action)");

    for (const agent of AGENT_INSTALLS) {
      const option = TERMINAL_AGENT_OPTIONS.find((candidate) => candidate.id === agent.id);
      if (!option) throw new Error(`Missing Terminal install option for ${agent.id}`);
      expect(option.installPackage).toBe(agent.npmPackage);

      const command = terminalAgentInstallCommand(option);
      for (const segment of terminalNpmInstallCommand(agent).split("; ")) expect(command).toContain(segment);
      const visible = terminalAgentVisibleInstallCommand(option);
      expect(terminalAgentCreateOptions(option, "install")).toEqual({ cmd: visible });
      expect(visible).toContain('export PATH="$MATRIX_NODE_PREFIX/bin:$PATH"');
      expect(visible).toMatch(/^sh -lc .*printf /);
      expect(terminalTabLaunchFields({ cmd: visible })).toEqual({ command: ["sh", "-lc", visible] });
      expect(visible).not.toMatch(/matrix-install-tool-pack|MATRIX_INSTALL_TOOL_PACK/);
    }

    expect(`${terminalSidebar}\n${mobileTerminalControls}`).not.toMatch(/matrix-install-tool-pack|MATRIX_INSTALL_TOOL_PACK/);
  });

  it("defines npm-compatible install commands for popular package managers", () => {
    expect(PACKAGE_MANAGER_INSTALLS.map((manager) => manager.id)).toEqual(["npm", "pnpm", "bun", "yarn"]);

    for (const agent of AGENT_INSTALLS) {
      for (const manager of PACKAGE_MANAGER_INSTALLS) {
        const command = manager.commandFor(agent);
        expect(command).toContain(agent.npmPackage);
        expect(command).toContain(manager.executable);

        if (agent.ignoreScripts) {
          expect(command).toContain("--ignore-scripts");
        } else {
          expect(command).not.toContain("--ignore-scripts");
          if (manager.id === "pnpm") {
            expect(command).toContain("--allow-build=");
          }
          if (manager.id === "bun") {
            expect(command).toContain("--trust");
          }
        }
      }
    }
  });

  it("runs scheduled smoke tests across all configured package managers", () => {
    const workflow = readFileSync(join(root, ".github/workflows/agent-install-smoke.yml"), "utf8");
    const smokeTest = readFileSync(join(root, "tests/platform/agent-cli-install-smoke.integration.ts"), "utf8");

    expect(workflow).toContain('default: "npm,pnpm,bun,yarn"');
    expect(workflow).toContain("npm install -g yarn@1.22.22");
    expect(workflow).toContain("timeout-minutes: 90");
    expect(smokeTest).toContain('?? "npm,pnpm,bun,yarn"');
  });

  it("tracks official curl installers only where upstream documents them", () => {
    const curlAgents = AGENT_INSTALLS.filter((agent) => agent.curlInstall);

    expect(curlAgents.map((agent) => agent.id)).toEqual(["claude", "codex", "opencode"]);
    expect(curlAgents.map((agent) => agent.curlInstall?.docsCommand)).toEqual([
      "curl -fsSL https://claude.ai/install.sh | bash",
      "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
      "curl -fsSL https://opencode.ai/install | bash",
    ]);

    for (const agent of curlAgents) {
      expect(agent.curlInstall?.smokeCommand).toContain("curl -fsSL --connect-timeout 10 --max-time 120");
    }

    expect(AGENT_INSTALLS.find((agent) => agent.id === "pi")?.curlInstall).toBeUndefined();
  });

  it("keeps the host-bundle pack installer aligned with npm package names", () => {
    const installer = readFileSync(join(root, "distro/customer-vps/host-bin/matrix-install-tool-pack"), "utf8");

    expect(installer).toContain('"@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"');
    expect(installer).toContain('"@openai/codex@${CODEX_VERSION}"');
    expect(AGENT_INSTALLS.find((agent) => agent.id === "codex")?.npmPackage)
      .toBe(CODEX_VERIFIED_NPM_PACKAGE);
    expect(installer).toContain('"opencode-ai@${OPENCODE_AI_VERSION}"');
    expect(installer).toContain('"@earendil-works/pi-coding-agent@${PI_CODING_AGENT_VERSION}"');
    expect(installer).toContain("run_npm_install install -g --ignore-scripts --prefix");
  });
});
