import { defineCommand } from "citty";

const COMMANDS = [
  "login",
  "logout",
  "sync",
  "peers",
  "shell",
  "sh",
  "profile",
  "whoami",
  "status",
  "run",
  "doctor",
  "instance",
  "completion",
];

const SHELL_COMMANDS = [
  "list",
  "ls",
  "new",
  "connect",
  "attach",
  "rm",
  "tab",
  "pane",
  "layout",
];

function bashCompletion(): string {
  return `# Matrix CLI completion for bash
_matrix_shell_sessions() {
  matrix shell list --json 2>/dev/null \\
    | tr ',' '\\n' \\
    | sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p'
}

_matrix_completion() {
  local cur command shell_command
  cur="\${COMP_WORDS[COMP_CWORD]}"
  command="\${COMP_WORDS[1]}"
  shell_command="\${COMP_WORDS[2]}"

  if [[ "$COMP_CWORD" -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${COMMANDS.join(" ")}" -- "$cur") )
    return 0
  fi

  if [[ "$command" == "shell" || "$command" == "sh" ]]; then
    if [[ "$COMP_CWORD" -eq 3 && ("$shell_command" == "connect" || "$shell_command" == "attach" || "$shell_command" == "rm") ]]; then
      COMPREPLY=( $(compgen -W "$(_matrix_shell_sessions)" -- "$cur") )
      return 0
    fi
    COMPREPLY=( $(compgen -W "${SHELL_COMMANDS.join(" ")}" -- "$cur") )
    return 0
  fi
}
complete -F _matrix_completion matrix
`;
}

function zshCompletion(): string {
  return `#compdef matrix
# Matrix CLI completion for zsh
_matrix_shell_sessions() {
  matrix shell list --json 2>/dev/null \\
    | tr ',' '\\n' \\
    | sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p'
}

_matrix() {
  local -a commands shell_commands shell_sessions
  commands=(${COMMANDS.map((command) => `'${command}:${command}'`).join(" ")})
  shell_commands=(${SHELL_COMMANDS.map((command) => `'${command}:${command}'`).join(" ")})

  if (( CURRENT == 2 )); then
    _describe 'matrix command' commands
    return
  fi

  if [[ "\${words[2]}" == "shell" || "\${words[2]}" == "sh" ]]; then
    if (( CURRENT == 4 )) && [[ "\${words[3]}" == "connect" || "\${words[3]}" == "attach" || "\${words[3]}" == "rm" ]]; then
      shell_sessions=("\${(@f)$(_matrix_shell_sessions)}")
      _describe 'matrix shell session' shell_sessions
      return
    fi
    _describe 'matrix shell command' shell_commands
    return
  fi

  _files
}
compdef _matrix matrix
`;
}

function fishCompletion(): string {
  const commandList = COMMANDS.join(" ");
  const shellCommandList = SHELL_COMMANDS.join(" ");
  return `# Matrix CLI completion for fish
complete -c matrix -f -n '__fish_use_subcommand' -a '${commandList}'
complete -c matrix -f -n '__fish_seen_subcommand_from shell sh' -a '${shellCommandList}'
complete -c matrix -f -n '__fish_seen_subcommand_from shell sh; and __fish_seen_subcommand_from connect attach rm' -a '(matrix shell list --json 2>/dev/null | tr "," "\\n" | sed -n "s/.*\\"name\\"[[:space:]]*:[[:space:]]*\\"\\\\([^\\"]*\\\\)\\".*/\\\\1/p")'
`;
}

function completionFor(shell: string | undefined): string {
  switch (shell) {
    case "bash":
      return bashCompletion();
    case "zsh":
      return zshCompletion();
    case "fish":
      return fishCompletion();
    default:
      return [
        "Usage: matrix completion bash|zsh|fish",
        "",
        "Commands:",
        COMMANDS.join("\n"),
      ].join("\n");
  }
}

export const completionCommand = defineCommand({
  meta: { name: "completion", description: "Print shell completion scripts" },
  args: {
    shell: { type: "positional", required: false },
  },
  run: ({ args }) => {
    console.log(completionFor(typeof args.shell === "string" ? args.shell : undefined));
  },
});
