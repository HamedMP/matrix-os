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
_matrix_completion() {
  local cur command
  cur="\${COMP_WORDS[COMP_CWORD]}"
  command="\${COMP_WORDS[1]}"

  if [[ "$COMP_CWORD" -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${COMMANDS.join(" ")}" -- "$cur") )
    return 0
  fi

  if [[ "$command" == "shell" || "$command" == "sh" ]]; then
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
_matrix() {
  local -a commands shell_commands
  commands=(${COMMANDS.map((command) => `'${command}:${command}'`).join(" ")})
  shell_commands=(${SHELL_COMMANDS.map((command) => `'${command}:${command}'`).join(" ")})

  if (( CURRENT == 2 )); then
    _describe 'matrix command' commands
    return
  fi

  if [[ "\${words[2]}" == "shell" || "\${words[2]}" == "sh" ]]; then
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
