import { join, resolve } from "node:path";

export type MatrixZellijConfigPaths = {
  dir: string;
  file: string;
  shellFile: string;
  bashrcFile: string;
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

export function matrixZellijConfigPaths(homePath: string): MatrixZellijConfigPaths {
  const zellijDir = join(resolve(homePath), "system", "zellij");
  return {
    dir: zellijDir,
    file: join(zellijDir, "config.kdl"),
    shellFile: join(zellijDir, "matrix-terminal-shell"),
    bashrcFile: join(zellijDir, "bashrc"),
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

export function matrixTerminalShellScript(bashrcPath: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

export MATRIX_HOME="\${MATRIX_HOME:-\${HOME:-/home/matrix/home}}"
export HOME="\${HOME:-$MATRIX_HOME}"
export MATRIX_TERMINAL_PROMPT="\${MATRIX_TERMINAL_PROMPT:-\\\\[\\\\e[1;36m\\\\]\\\\u\\\\[\\\\e[0m\\\\]:\\\\[\\\\e[1;34m\\\\]\\\\w\\\\[\\\\e[0m\\\\]\\\\$ }"

exec bash --noprofile --rcfile ${shellSingleQuote(bashrcPath)} -i
`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
