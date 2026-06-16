import { join, resolve } from "node:path";

export type MatrixZellijConfigPaths = {
  dir: string;
  file: string;
  shellFile: string;
  bashrcFile: string;
  promptLabelFile: string;
  layoutDir: string;
  layoutFile: string;
};

export const MATRIX_ZELLIJ_LAYOUT = `// Matrix OS keeps Zellij chrome compact; the browser shell renders sessions and actions.
layout {
  default_tab_template {
    children
    pane size=1 borderless=true {
      plugin location="zellij:compact-bar"
    }
  }

  tab name="main" {
    pane
  }
}
`;

export const MATRIX_TERMINAL_BASHRC = `# Matrix OS generated terminal rcfile.
if [ -r "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi

if [ -n "\${MATRIX_TERMINAL_PROMPT:-}" ]; then
  PS1="\${MATRIX_TERMINAL_PROMPT}"
else
  PS1="\\u:\\w\\$ "
fi
`;

export const MATRIX_TERMINAL_PROMPT_LABEL_SCRIPT = `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROMPT_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

function sanitizePromptLabel(value) {
  if (typeof value !== "string") return null;
  const label = value.trim().replace(/^@+/, "").replace(/\\s+/g, "-");
  if (!PROMPT_LABEL_PATTERN.test(label)) return null;
  return label;
}

try {
  const matrixHome = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const raw = readFileSync(join(matrixHome, "system", "handle.json"), "utf8");
  const parsed = JSON.parse(raw);
  const label = sanitizePromptLabel(parsed?.handle) ?? sanitizePromptLabel(parsed?.displayName);
  if (label) process.stdout.write(label);
} catch (err) {
  const isFileMissing = err != null && typeof err === "object" && "code" in err && err.code === "ENOENT";
  if (!isFileMissing || process.env.MATRIX_TERMINAL_PROMPT_DEBUG === "1") {
    console.error("[matrix-terminal-prompt] unable to read owner identity", err);
  }
}
`;

export function matrixZellijConfigPaths(homePath: string): MatrixZellijConfigPaths {
  const zellijDir = join(resolve(homePath), "system", "zellij");
  return {
    dir: zellijDir,
    file: join(zellijDir, "config.kdl"),
    shellFile: join(zellijDir, "matrix-terminal-shell"),
    bashrcFile: join(zellijDir, "bashrc"),
    promptLabelFile: join(zellijDir, "prompt-label.mjs"),
    layoutDir: join(zellijDir, "layouts"),
    layoutFile: join(zellijDir, "layouts", "matrix.kdl"),
  };
}

export function renderMatrixZellijConfig(configPaths: MatrixZellijConfigPaths): string {
  return `// Matrix OS generated shell config.
pane_frames false
simplified_ui true
default_layout "matrix"
default_shell ${JSON.stringify(configPaths.shellFile)}
theme "default"
`;
}

export function matrixTerminalShellScript(bashrcPath: string, promptLabelPath: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

export MATRIX_HOME="\${MATRIX_HOME:-\${HOME:-/home/matrix/home}}"
export HOME="\${HOME:-$MATRIX_HOME}"
if [ -z "\${MATRIX_TERMINAL_PROMPT:-}" ]; then
  matrix_prompt_label=""
  if command -v node >/dev/null 2>&1; then
    matrix_prompt_label="$(node ${shellSingleQuote(promptLabelPath)} 2>/dev/null || true)"
  fi

  if [ -n "$matrix_prompt_label" ]; then
    export MATRIX_TERMINAL_PROMPT="\\\\[\\\\e[1;36m\\\\]$matrix_prompt_label\\\\[\\\\e[0m\\\\]:\\\\[\\\\e[1;34m\\\\]\\\\w\\\\[\\\\e[0m\\\\]\\\\$ "
  else
    export MATRIX_TERMINAL_PROMPT="\\\\[\\\\e[1;36m\\\\]\\\\u\\\\[\\\\e[0m\\\\]:\\\\[\\\\e[1;34m\\\\]\\\\w\\\\[\\\\e[0m\\\\]\\\\$ "
  fi
fi

exec bash --noprofile --rcfile ${shellSingleQuote(bashrcPath)} -i
`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
