import { defineCommand } from "citty";
import { requireCliAuthToken } from "../auth-state.js";
import { completeRemotePaths } from "../file-transfer-client.js";
import { resolveCliProfile } from "../profiles.js";

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
  "port",
  "forward",
  "upload",
  "download",
  "agent",
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

_matrix_remote_paths() {
  matrix completion paths "$1" 2>/dev/null
}

_matrix_transfer_position() {
  local i word skip=0 position=0
  for ((i = 2; i < COMP_CWORD; i++)); do
    word="\${COMP_WORDS[i]}"
    if ((skip)); then
      skip=0
      continue
    fi
    case "$word" in
      --profile|--gateway|--token) skip=1 ;;
      --profile=*|--gateway=*|--token=*|--force|--secret|--dev|--json) ;;
      --*) ;;
      *) ((position += 1)) ;;
    esac
  done
  printf '%s' "$position"
}

_matrix_completion() {
  local cur command shell_command transfer_position
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

  if [[ "$command" == "upload" ]]; then
    transfer_position="$(_matrix_transfer_position)"
    if [[ "$transfer_position" -eq 0 ]]; then
      COMPREPLY=( $(compgen -f -- "$cur") )
      return 0
    fi
    while IFS= read -r candidate; do
      [[ "$candidate" == "$cur"* ]] && COMPREPLY+=("$candidate")
    done < <(_matrix_remote_paths "$cur")
    compopt -o nospace 2>/dev/null || true
    return 0
  fi

  if [[ "$command" == "download" ]]; then
    transfer_position="$(_matrix_transfer_position)"
    if [[ "$transfer_position" -eq 0 ]]; then
      while IFS= read -r candidate; do
        [[ "$candidate" == "$cur"* ]] && COMPREPLY+=("$candidate")
      done < <(_matrix_remote_paths "$cur")
      compopt -o nospace 2>/dev/null || true
      return 0
    fi
    COMPREPLY=( $(compgen -f -- "$cur") )
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

_matrix_remote_paths() {
  matrix completion paths "$1" 2>/dev/null
}

_matrix_transfer_position() {
  local i word skip=0 position=0
  for ((i = 3; i < CURRENT; i++)); do
    word="\${words[i]}"
    if ((skip)); then
      skip=0
      continue
    fi
    case "$word" in
      --profile|--gateway|--token) skip=1 ;;
      --profile=*|--gateway=*|--token=*|--force|--secret|--dev|--json) ;;
      --*) ;;
      *) ((position += 1)) ;;
    esac
  done
  REPLY="$position"
}

_matrix() {
  local -a commands shell_commands shell_sessions
  local REPLY
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

  if [[ "\${words[2]}" == "upload" ]]; then
    _matrix_transfer_position
    if (( REPLY == 0 )); then
      _files
      return
    fi
    shell_sessions=("\${(@f)$(_matrix_remote_paths "\${words[CURRENT]}")}")
    compadd -Q -S '' -- "\${shell_sessions[@]}"
    return
  fi

  if [[ "\${words[2]}" == "download" ]]; then
    _matrix_transfer_position
    if (( REPLY == 0 )); then
      shell_sessions=("\${(@f)$(_matrix_remote_paths "\${words[CURRENT]}")}")
      compadd -Q -S '' -- "\${shell_sessions[@]}"
      return
    fi
    _files
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
function __matrix_transfer_position
  set -l tokens (commandline -opc)
  set -l current_token (commandline -ct)
  if test -n "$current_token"; and test (count $tokens) -gt 2
    set -e tokens[-1]
  end
  set -l skip 0
  set -l position 0
  for word in $tokens[3..-1]
    if test $skip -eq 1
      set skip 0
      continue
    end
    switch $word
      case --profile --gateway --token
        set skip 1
      case '--profile=*' '--gateway=*' '--token=*' --force --secret --dev --json '--*'
      case '*'
        set position (math $position + 1)
    end
  end
  echo $position
end

complete -c matrix -f -n '__fish_use_subcommand' -a '${commandList}'
complete -c matrix -f -n '__fish_seen_subcommand_from shell sh; and not __fish_seen_subcommand_from ${SHELL_COMMANDS.join(" ")}' -a '${shellCommandList}'
complete -c matrix -f -n '__fish_seen_subcommand_from shell sh; and __fish_seen_subcommand_from connect attach rm' -a '(matrix shell list --json 2>/dev/null | tr "," "\\n" | sed -n "s/.*\\"name\\"[[:space:]]*:[[:space:]]*\\"\\\\([^\\"]*\\\\)\\".*/\\\\1/p")'
complete -c matrix -F -n '__fish_seen_subcommand_from upload; and test (__matrix_transfer_position) -eq 0'
complete -c matrix -f -n '__fish_seen_subcommand_from upload; and test (__matrix_transfer_position) -ge 1' -a '(matrix completion paths (commandline -ct) 2>/dev/null)'
complete -c matrix -f -n '__fish_seen_subcommand_from download; and test (__matrix_transfer_position) -eq 0' -a '(matrix completion paths (commandline -ct) 2>/dev/null)'
complete -c matrix -F -n '__fish_seen_subcommand_from download; and test (__matrix_transfer_position) -ge 1'
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
    prefix: { type: "positional", required: false },
    profile: { type: "string", required: false },
    dev: { type: "boolean", required: false, default: false },
    gateway: { type: "string", required: false },
    token: { type: "string", required: false },
  },
  run: async ({ args }) => {
    const shell = typeof args.shell === "string" ? args.shell : undefined;
    if (shell === "paths") {
      try {
        const profile = await resolveCliProfile(args);
        const token = await requireCliAuthToken(profile);
        const paths = await completeRemotePaths(
          { gatewayUrl: profile.gatewayUrl, token },
          typeof args.prefix === "string" ? args.prefix : "~/",
        );
        if (paths.length > 0) process.stdout.write(`${paths.join("\n")}\n`);
      } catch (err) {
        // Completion must stay silent when auth or the remote instance is unavailable.
        if (process.env.MATRIX_CLI_DEBUG === "1") {
          const kind = err instanceof Error ? err.name : typeof err;
          console.error(`[debug] remote path completion unavailable: ${kind}`);
        }
      }
      return;
    }
    console.log(completionFor(shell));
  },
});
