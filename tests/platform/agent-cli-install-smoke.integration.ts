import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { AGENT_INSTALLS, PACKAGE_MANAGER_INSTALLS, packageBuildName, type AgentInstallDefinition, type PackageManagerInstallDefinition } from "./agent-install-matrix";

interface Sandbox {
  root: string;
  home: string;
  prefix: string;
}

const liveEnabled = process.env.MATRIX_AGENT_INSTALL_SMOKE === "1";
const selectedManagers = (process.env.MATRIX_AGENT_INSTALL_SMOKE_MANAGERS ?? "npm,pnpm,bun,yarn")
  .split(",")
  .map((manager) => manager.trim())
  .filter(Boolean);

const tempDirs: string[] = [];
const describeLive = liveEnabled ? describe : describe.skip;

afterEach(() => {
  const tempDir = tempDirs.pop();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function commandExists(command: string): boolean {
  return spawnSync("bash", ["-lc", `command -v ${command} >/dev/null 2>&1`], {
    encoding: "utf8",
  }).status === 0;
}

function createSandbox(agent: AgentInstallDefinition, method: string): Sandbox {
  const root = mkdtempSync(join(tmpdir(), `matrix-agent-${agent.id}-${method}-`));
  const sandbox = {
    root,
    home: join(root, "home"),
    prefix: join(root, "node-prefix"),
  };
  mkdirSync(join(sandbox.home, ".local", "bin"), { recursive: true });
  mkdirSync(join(sandbox.prefix, "bin"), { recursive: true });
  tempDirs.push(root);
  return sandbox;
}

function sandboxEnv(sandbox: Sandbox): NodeJS.ProcessEnv {
  const extraPath = [
    join(sandbox.prefix, "bin"),
    join(sandbox.prefix, "pnpm-bin"),
    join(sandbox.prefix, "bun", "bin"),
    join(sandbox.prefix, "yarn", "bin"),
    join(sandbox.home, ".local", "bin"),
    join(sandbox.home, ".claude", "bin"),
    join(sandbox.home, ".codex", "bin"),
    join(sandbox.home, ".opencode", "bin"),
  ].join(":");

  return {
    ...process.env,
    HOME: sandbox.home,
    XDG_CACHE_HOME: join(sandbox.home, ".cache"),
    XDG_CONFIG_HOME: join(sandbox.home, ".config"),
    XDG_DATA_HOME: join(sandbox.home, ".local", "share"),
    XDG_STATE_HOME: join(sandbox.home, ".local", "state"),
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    PATH: `${extraPath}:${process.env.PATH ?? ""}`,
  };
}

function runSmokeScript(label: string, script: string, sandbox: Sandbox): void {
  const result = spawnSync("bash", ["-lc", script], {
    cwd: sandbox.home,
    encoding: "utf8",
    env: sandboxEnv(sandbox),
    maxBuffer: 10 * 1024 * 1024,
    timeout: 240_000,
  });

  expect(result.status, [
    `${label} failed`,
    "--- stdout ---",
    result.stdout,
    "--- stderr ---",
    result.stderr,
  ].join("\n")).toBe(0);
}

function verifyBinaryScript(agent: AgentInstallDefinition): string {
  const binary = shellQuote(agent.binary);
  return `
resolved="$(command -v ${binary} 2>/dev/null || true)"
if [ -z "$resolved" ]; then
  for candidate in \
    "$MATRIX_NODE_PREFIX/bin/${agent.binary}" \
    "$PNPM_HOME/${agent.binary}" \
    "$BUN_INSTALL/bin/${agent.binary}" \
    "$YARN_PREFIX/bin/${agent.binary}" \
    "$HOME/.local/bin/${agent.binary}" \
    "$HOME/.claude/bin/${agent.binary}" \
    "$HOME/.codex/bin/${agent.binary}" \
    "$HOME/.opencode/bin/${agent.binary}"
  do
    if [ -x "$candidate" ]; then
      resolved="$candidate"
      break
    fi
  done
fi
test -n "$resolved"
"$resolved" --version >/dev/null 2>&1 || "$resolved" --help >/dev/null 2>&1
`;
}

function packageInstallScript(agent: AgentInstallDefinition, manager: PackageManagerInstallDefinition, sandbox: Sandbox): string {
  const packageName = shellQuote(agent.npmPackage);
  const ignoreScripts = agent.ignoreScripts ? "--ignore-scripts " : "";

  if (manager.id === "npm") {
    return `
export MATRIX_NODE_PREFIX=${shellQuote(sandbox.prefix)}
npm install -g ${ignoreScripts}--prefix "$MATRIX_NODE_PREFIX" ${packageName}
${verifyBinaryScript(agent)}
`;
  }

  if (manager.id === "pnpm") {
    const buildFlag = agent.ignoreScripts ? "" : `--allow-build=${shellQuote(packageBuildName(agent))} `;
    return `
export MATRIX_NODE_PREFIX=${shellQuote(sandbox.prefix)}
export PNPM_HOME="$MATRIX_NODE_PREFIX/pnpm-bin"
mkdir -p "$PNPM_HOME"
pnpm add -g ${ignoreScripts}${buildFlag}${packageName}
${verifyBinaryScript(agent)}
`;
  }

  if (manager.id === "bun") {
    const trustFlag = agent.ignoreScripts ? "" : "--trust ";
    return `
export MATRIX_NODE_PREFIX=${shellQuote(sandbox.prefix)}
export BUN_INSTALL="$MATRIX_NODE_PREFIX/bun"
mkdir -p "$BUN_INSTALL/bin"
bun install -g ${ignoreScripts}${trustFlag}${packageName}
${verifyBinaryScript(agent)}
`;
  }

  return `
export MATRIX_NODE_PREFIX=${shellQuote(sandbox.prefix)}
export YARN_PREFIX="$MATRIX_NODE_PREFIX/yarn"
yarn global add --prefix "$YARN_PREFIX" ${ignoreScripts}${packageName}
${verifyBinaryScript(agent)}
`;
}

describeLive("live agent CLI install smoke", () => {
  it("has the selected package-manager binaries", () => {
    for (const managerId of selectedManagers) {
      const manager = PACKAGE_MANAGER_INSTALLS.find((item) => item.id === managerId);
      expect(manager, `unknown package manager ${managerId}`).toBeDefined();
      expect(commandExists(manager!.executable), `${manager!.executable} is required for MATRIX_AGENT_INSTALL_SMOKE_MANAGERS=${selectedManagers.join(",")}`).toBe(true);
    }
  });

  for (const agent of AGENT_INSTALLS) {
    for (const manager of PACKAGE_MANAGER_INSTALLS) {
      const selected = selectedManagers.includes(manager.id);
      const available = commandExists(manager.executable);
      const testFn = selected && available ? it : it.skip;

      testFn(
        `installs ${agent.label} with ${manager.id}`,
        () => {
          const sandbox = createSandbox(agent, manager.id);
          runSmokeScript(
            `${agent.label} ${manager.id} install`,
            packageInstallScript(agent, manager, sandbox),
            sandbox,
          );
        },
        300_000,
      );
    }
  }

  for (const agent of AGENT_INSTALLS.filter((item) => item.curlInstall)) {
    it(
      `installs ${agent.label} with the official curl installer`,
      () => {
        const sandbox = createSandbox(agent, "curl");
        const script = `
export MATRIX_NODE_PREFIX=${shellQuote(sandbox.prefix)}
export PNPM_HOME="$MATRIX_NODE_PREFIX/pnpm-bin"
export BUN_INSTALL="$MATRIX_NODE_PREFIX/bun"
export YARN_PREFIX="$MATRIX_NODE_PREFIX/yarn"
${agent.curlInstall?.smokeCommand}
${verifyBinaryScript(agent)}
`;
        runSmokeScript(`${agent.label} curl install`, script, sandbox);
      },
      300_000,
    );
  }

  it("does not invent a curl installer for Pi until upstream publishes one", () => {
    expect(AGENT_INSTALLS.find((agent) => agent.id === "pi")?.curlInstall).toBeUndefined();
  });
});

if (!liveEnabled && existsSync(join(process.cwd(), "tests/platform/agent-cli-install-smoke.integration.ts"))) {
  describe("live agent CLI install smoke gate", () => {
    it("is opt-in to avoid executing third-party install scripts in every unit run", () => {
      expect(process.env.MATRIX_AGENT_INSTALL_SMOKE).not.toBe("1");
    });
  });
}
