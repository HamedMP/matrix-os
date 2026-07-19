import { dirname, join, resolve } from "node:path";

export const MATRIX_ZELLIJ_LAYOUT_NAME = "matrix";
export type MatrixZellijShellThemeId = "dark" | "light" | "matrix";

export type MatrixZellijConfigPaths = {
  dir: string;
  file: string;
  shellFile: string;
  zshrcFile: string;
  bashrcFile: string;
  promptLabelFile: string;
  layoutDir: string;
  layoutFile: string;
};

export const MATRIX_ZELLIJ_LAYOUT = `// Matrix OS chrome-free Zellij layout, shared by desktop and mobile clients.
layout {
  tab name="main" {
    pane
  }
}
`;

const MATRIX_TERMINAL_PATH_BOOTSTRAP = `matrix_prepend_terminal_path() {
  local entry="$1"
  [ -n "$entry" ] || return 0
  case ":\${PATH:-}:" in
    *":$entry:"*) ;;
    *) PATH="$entry\${PATH:+:$PATH}" ;;
  esac
  export PATH
}

matrix_prepend_terminal_path "/opt/matrix/bin"
matrix_prepend_terminal_path "\${MATRIX_NODE_PREFIX:-/opt/matrix/runtime/node}/bin"
if [ -n "\${MATRIX_HOME:-}" ]; then
  matrix_prepend_terminal_path "$MATRIX_HOME/.local/bin"
fi
`;

export const MATRIX_TERMINAL_ZSHRC = `# Matrix OS generated terminal rcfile.
if [ -r "$HOME/.zshenv" ]; then
  matrix_terminal_zdotdir="$ZDOTDIR"
  ZDOTDIR="$HOME"
  . "$HOME/.zshenv"
  ZDOTDIR="$matrix_terminal_zdotdir"
  unset matrix_terminal_zdotdir
fi

if [ -r "$HOME/.zshrc" ]; then
  matrix_terminal_zdotdir="$ZDOTDIR"
  ZDOTDIR="$HOME"
  . "$HOME/.zshrc"
  ZDOTDIR="$matrix_terminal_zdotdir"
  unset matrix_terminal_zdotdir
fi

${MATRIX_TERMINAL_PATH_BOOTSTRAP}

autoload -Uz add-zsh-hook
matrix_terminal_apply_prompt() {
  if [ -n "\${MATRIX_TERMINAL_PROMPT:-}" ]; then
    PROMPT="\${MATRIX_TERMINAL_PROMPT}"
  else
    PROMPT="%n:%~%# "
  fi
}
add-zsh-hook precmd matrix_terminal_apply_prompt
matrix_terminal_apply_prompt
`;

export const MATRIX_TERMINAL_BASHRC = `# Matrix OS generated fallback terminal rcfile.
if [ -r "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi

${MATRIX_TERMINAL_PATH_BOOTSTRAP}

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
    zshrcFile: join(zellijDir, ".zshrc"),
    bashrcFile: join(zellijDir, "bashrc"),
    promptLabelFile: join(zellijDir, "prompt-label.mjs"),
    layoutDir: join(zellijDir, "layouts"),
    layoutFile: join(zellijDir, "layouts", "matrix.kdl"),
  };
}

export function zellijThemeForShellTheme(themeId: MatrixZellijShellThemeId): "default" | "gruvbox-light" | "matrix" {
  switch (themeId) {
    case "light":
      return "gruvbox-light";
    case "matrix":
      return "matrix";
    case "dark":
      return "default";
  }
}

export function renderMatrixZellijConfig(
  configPaths: MatrixZellijConfigPaths,
  themeId: MatrixZellijShellThemeId = "dark",
): string {
  return `// Matrix OS generated shell config.
// Paper shell themes: dark=default, light=gruvbox-light, matrix=matrix.
pane_frames false
simplified_ui true
hide_session_name true
default_layout "${MATRIX_ZELLIJ_LAYOUT_NAME}"
default_shell ${JSON.stringify(configPaths.shellFile)}
theme "${zellijThemeForShellTheme(themeId)}"

themes {
  matrix {
    fg 47 191 85
    bg 2 10 2
    black 2 10 2
    red 47 191 85
    green 57 255 106
    yellow 91 240 138
    blue 31 176 78
    magenta 57 255 106
    cyan 57 255 106
    white 216 255 217
    orange 91 240 138
  }
}
`;
}

export function matrixTerminalShellScript(
  zshrcPath: string,
  bashrcPath: string,
  promptLabelPath: string,
): string {
  const zshConfigDir = dirname(resolve(zshrcPath));
  return `#!/usr/bin/env bash
set -euo pipefail

export MATRIX_HOME="\${MATRIX_HOME:-\${HOME:-/home/matrix/home}}"
export HOME="\${HOME:-$MATRIX_HOME}"
${MATRIX_TERMINAL_PATH_BOOTSTRAP}

matrix_prompt_label=""
if [ -z "\${MATRIX_TERMINAL_PROMPT:-}" ] && command -v node >/dev/null 2>&1; then
  matrix_prompt_label="$(node ${shellSingleQuote(promptLabelPath)} 2>/dev/null || true)"
fi

if [ "$#" -gt 0 ]; then
  set +e
  ( "$@" )
  set -e
fi

matrix_zsh="$(command -v zsh 2>/dev/null || true)"
if [ -n "$matrix_zsh" ]; then
  if [ -z "\${MATRIX_TERMINAL_PROMPT:-}" ]; then
    if [ -n "$matrix_prompt_label" ]; then
      export MATRIX_TERMINAL_PROMPT="%B%F{cyan}$matrix_prompt_label%f%b:%B%F{blue}%~%f%b%# "
    else
      export MATRIX_TERMINAL_PROMPT="%B%F{cyan}%n%f%b:%B%F{blue}%~%f%b%# "
    fi
  fi
  export ZDOTDIR=${shellSingleQuote(zshConfigDir)}
  export SHELL="$matrix_zsh"
  exec "$matrix_zsh" -d -i
fi

if [ -z "\${MATRIX_TERMINAL_PROMPT:-}" ]; then
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
