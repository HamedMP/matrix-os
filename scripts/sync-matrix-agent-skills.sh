#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -gt 0 ]; then
  MATRIX_SKILLS_SOURCE="$1"
else
  MATRIX_SKILLS_SOURCE="${MATRIX_SKILLS_SOURCE:-}"
fi

if [ -z "${MATRIX_SKILLS_SOURCE:-}" ]; then
  if [ -d "/opt/matrix/app/skills/matrix" ]; then
    MATRIX_SKILLS_SOURCE="/opt/matrix/app/skills/matrix"
  elif [ -d "/app/skills/matrix" ]; then
    MATRIX_SKILLS_SOURCE="/app/skills/matrix"
  elif [ -d "skills/matrix" ]; then
    MATRIX_SKILLS_SOURCE="$(pwd)/skills/matrix"
  else
    echo "Matrix skills source not found. Set MATRIX_SKILLS_SOURCE or pass a source path." >&2
    exit 1
  fi
fi

case "$MATRIX_SKILLS_SOURCE" in *$'\n'*)
  echo "Invalid Matrix skill source path; existing skills were preserved." >&2
  exit 1 ;;
esac

if [ ! -d "$MATRIX_SKILLS_SOURCE" ]; then
  echo "Matrix skills source not found: $MATRIX_SKILLS_SOURCE" >&2
  exit 1
fi

MATRIX_SKILLS_SOURCE="$(cd -P "$MATRIX_SKILLS_SOURCE" && printf '%s.' "$PWD")"
MATRIX_SKILLS_SOURCE="${MATRIX_SKILLS_SOURCE%.}"
case "$MATRIX_SKILLS_SOURCE" in *$'\n'*)
  echo "Invalid Matrix skill source path; existing skills were preserved." >&2
  exit 1 ;;
esac

MATRIX_HOME="${MATRIX_HOME:-$HOME/matrixos}"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
MATRIX_AGENT_SKILLS_ROOT="${MATRIX_AGENT_SKILLS_ROOT:-${AGENT_HOME:-$HOME/.agent}/skills}"
# Namespace mode never falls back to defaults: the variable must be set, may
# be empty (no agents), and may only name known agents. Checked before any change.
if [ -n "${MATRIX_SKILL_NAMESPACE:-}" ]; then
  if [ -z "${MATRIX_SKILL_TARGETS+set}" ]; then
    echo "Org skill targets must be set explicitly; existing skills were preserved." >&2
    exit 1
  fi
  IFS=, read -r -a requested_targets <<< "$MATRIX_SKILL_TARGETS"
  for requested_target in "${requested_targets[@]}"; do
    case "$requested_target" in
      matrix|claude|codex|hermes|agent) ;;
      *) echo "Invalid org skill target; existing skills were preserved." >&2; exit 1 ;;
    esac
  done
  MATRIX_SKILL_TARGETS=",$MATRIX_SKILL_TARGETS,"
else
  MATRIX_SKILL_TARGETS=",${MATRIX_SKILL_TARGETS:-matrix,claude,codex},"
fi

# Namespace mode (Matrix Core repo, spec 2691): manage only `org-<slug>-*`
# entries that link into (or were copied from) MATRIX_SKILL_OWNED_ROOT. The
# default mode never treats `org-*` entries as its own.
MATRIX_SKILL_NAMESPACE="${MATRIX_SKILL_NAMESPACE:-}"
MATRIX_SKILL_OWNED_ROOT="${MATRIX_SKILL_OWNED_ROOT:-}"
if [ -n "$MATRIX_SKILL_NAMESPACE" ]; then
  if ! [[ "$MATRIX_SKILL_NAMESPACE" =~ ^org-[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?-$ ]] \
    || [ -z "$MATRIX_SKILL_OWNED_ROOT" ] || [ ! -d "$MATRIX_SKILL_OWNED_ROOT" ]; then
    echo "Invalid org skill namespace; existing skills were preserved." >&2
    exit 1
  fi
  MATRIX_SKILL_OWNED_ROOT="$(cd -P "$MATRIX_SKILL_OWNED_ROOT" && pwd)"
fi

has_target() {
  case "$MATRIX_SKILL_TARGETS" in
    *,"$1",*) return 0 ;;
    *) return 1 ;;
  esac
}

skill_name() {
  sed -n 's/^name:[[:space:]]*//p' "$1/SKILL.md" | head -1
}

is_matrix_owned_dir() {
  local path="$1" base
  base="$(basename "$path")"
  if [ -n "$MATRIX_SKILL_NAMESPACE" ]; then
    [[ "$base" == "$MATRIX_SKILL_NAMESPACE"* ]] || return 1
    if [ -L "$path" ]; then
      # A link into a pruned release dangles; its recorded target still proves ownership.
      case "$(readlink "$path")" in "$MATRIX_SKILL_OWNED_ROOT"/*) return 0 ;; esac
      case "$(realpath "$path" 2>/dev/null || true)" in "$MATRIX_SKILL_OWNED_ROOT"/*) return 0 ;; esac
      return 1
    fi
    # A copy is owned only when its marker names this exact org root: namespace
    # `org-acme-` also matches `org-acme-tools-*`, which belongs to another org.
    [ -f "$path/.matrix-os-managed" ] && [ "$(head -n 1 "$path/.matrix-os-managed")" = "$MATRIX_SKILL_OWNED_ROOT" ] && return 0
    return 1
  fi
  [[ "$base" == org-* ]] && return 1
  if [ -L "$path" ]; then
    local resolved expected_name
    resolved="$(realpath "$path" 2>/dev/null || true)"
    # Source ownership does not imply ownership of an owner's custom alias.
    # A marker reached through the symlink belongs to the source, not the link.
    [ -f "$path/SKILL.md" ] || return 1
    expected_name="$(skill_name "$path")"
    if [ -z "$expected_name" ]; then
      expected_name="matrix-$(basename "$resolved")"
    fi
    [ "$(basename "$path")" = "$expected_name" ] || return 1
    case "$resolved" in
      "$MATRIX_SKILLS_SOURCE"/*) return 0 ;;
    esac
    [ -f "$path/.matrix-os-managed" ] && return 0
    return 1
  fi
  [ -f "$path/.matrix-os-managed" ] && return 0
  [[ "$(basename "$path")" == matrix-* ]] && [ -f "$path/SKILL.md" ] && grep -q '^author:[[:space:]]*Matrix OS[[:space:]]*$' "$path/SKILL.md" && return 0
  return 1
}

cleanup_root() {
  local root="$1"
  mkdir -p "$root"
  for generated in "$root"/*; do
    [ -e "$generated" ] || [ -L "$generated" ] || continue
    if is_matrix_owned_dir "$generated"; then
      rm -rf "$generated"
    fi
  done
}

link_or_copy_skill() {
  local src="$1"
  local root="$2"
  local name="$3"
  local target="$root/$name"

  mkdir -p "$root"
  if [ -e "$target" ] || [ -L "$target" ]; then
    if is_matrix_owned_dir "$target"; then
      rm -rf "$target"
    else
      echo "Leaving user-managed skill untouched: $target" >&2
      return 0
    fi
  fi

  if ln -s "$src" "$target" 2>/dev/null; then
    return 0
  fi

  cp -a "$src" "$target"
  if [ -n "$MATRIX_SKILL_NAMESPACE" ]; then
    printf '%s\n' "$MATRIX_SKILL_OWNED_ROOT" > "$target/.matrix-os-managed"
  else
    touch "$target/.matrix-os-managed"
  fi
}

sync_root() {
  local root="$1"
  cleanup_root "$root"

  for src in "$MATRIX_SKILLS_SOURCE"/*; do
    [ -d "$src" ] || continue
    [ -f "$src/SKILL.md" ] || continue
    local name
    name="$(skill_name "$src")"
    if [ -z "$name" ]; then
      name="matrix-$(basename "$src")"
    fi
    if [ -n "$MATRIX_SKILL_NAMESPACE" ]; then
      # Same combined limit as the installer (CORE_REPO_MAX_SKILL_NAME_LENGTH, `org-<slug>-<name>`).
      if ! [[ "$name" == "$MATRIX_SKILL_NAMESPACE"* && "$name" =~ ^[a-z0-9-]{1,100}$ ]]; then
        echo "Org skill not installed (invalid name or over 100 characters): $(printf '%s' "$name" | tr -cd 'a-zA-Z0-9._-' | cut -c1-120)" >&2
        continue
      fi
    fi
    link_or_copy_skill "$src" "$root" "$name"
  done
}

# Resolve existing parents without creating a destination. Missing components
# are normalized lexically; existing symlinks are resolved by cd -P. The dot
# sentinel preserves trailing newlines until the explicit pathname rejection.
canonical_destination() {
  local path="$1" suffix="" parent segment normalized="/"
  local -a segments
  case "$path" in *$'\n'*) return 1 ;; esac
  while [ ! -d "$path" ]; do
    [ ! -e "$path" ] && [ ! -L "$path" ] || return 1
    parent="$(dirname "$path")"
    [ "$parent" != "$path" ] || return 1
    suffix="/$(basename "$path")$suffix"
    path="$parent"
  done
  path="$(cd -P "$path" && printf '%s.' "$PWD")" || return 1
  path="${path%.}"
  case "$path$suffix" in *$'\n'*) return 1 ;; esac
  IFS=/ read -r -a segments <<< "$path$suffix"
  for segment in "${segments[@]}"; do
    case "$segment" in
      ""|.) ;;
      ..) normalized="${normalized%/*}"; [ -n "$normalized" ] || normalized="/" ;;
      *) normalized="${normalized%/}/$segment" ;;
    esac
    # A missing component followed by .. can return to an existing parent.
    # Resolve each newly reachable directory before consuming the next segment,
    # so a subsequent symlink (and link/..) retains filesystem semantics.
    if [ -d "$normalized" ]; then
      normalized="$(cd -P "$normalized" && printf '%s.' "$PWD")" || return 1
      normalized="${normalized%.}"
      case "$normalized" in *$'\n'*) return 1 ;; esac
    elif [ -e "$normalized" ] || [ -L "$normalized" ]; then
      return 1
    fi
  done
  printf '%s\n' "$normalized"
}

validate_destination() {
  local destination source_prefix destination_prefix
  destination="$(canonical_destination "$1")" || {
    echo "Invalid Matrix skill destination; existing skills were preserved." >&2
    exit 1
  }
  source_prefix="${MATRIX_SKILLS_SOURCE%/}/"
  destination_prefix="${destination%/}/"
  case "$destination_prefix" in "$source_prefix"*)
    echo "Matrix skill source and destination must not overlap." >&2; exit 1 ;;
  esac
  case "$source_prefix" in "$destination_prefix"*)
    echo "Matrix skill source and destination must not overlap." >&2; exit 1 ;;
  esac
}

# Preflight every selected root before the first cleanup so invalid configuration
# cannot partly modify skills. Agent local refresh requires the canonical builder.
if has_target agent; then
  # The builder check proves a public Matrix pack. Namespace mode syncs an org
  # source, which has no builder; its destination is still validated.
  if [ -z "$MATRIX_SKILL_NAMESPACE" ]; then
    builder_skill="$MATRIX_SKILLS_SOURCE/app-builder/SKILL.md"
    if [ ! -f "$builder_skill" ] || [ -L "$builder_skill" ] || ! grep -q '^name:[[:space:]]*matrix-app-builder[[:space:]]*$' "$builder_skill"; then
      echo "Invalid local Matrix skills source; existing Agent skills were preserved." >&2
      exit 1
    fi
  fi
  validate_destination "$MATRIX_AGENT_SKILLS_ROOT"
fi
if has_target matrix; then validate_destination "$MATRIX_HOME/.agents/skills"; fi
if has_target codex; then
  validate_destination "$HOME/.agents/skills"
  if [ -d "$HOME/.codex/skills" ]; then validate_destination "$HOME/.codex/skills"; fi
fi
if has_target claude; then
  validate_destination "$HOME/.claude/skills"
  validate_destination "$MATRIX_HOME/.claude/skills"
fi
if has_target hermes; then validate_destination "$HERMES_HOME/skills"; fi

if has_target matrix; then
  sync_root "$MATRIX_HOME/.agents/skills"
fi

if has_target codex; then
  sync_root "$HOME/.agents/skills"
  # Older Matrix builds populated a non-standard Codex path. Clean only
  # Matrix-managed entries so stale duplicates do not shadow the canonical
  # OpenAI-documented ~/.agents/skills location.
  if [ -d "$HOME/.codex/skills" ]; then
    cleanup_root "$HOME/.codex/skills"
  fi
fi

if has_target claude; then
  sync_root "$HOME/.claude/skills"
  if [ "$MATRIX_HOME" != "$HOME" ]; then
    sync_root "$MATRIX_HOME/.claude/skills"
  fi
fi

if has_target agent; then
  sync_root "$MATRIX_AGENT_SKILLS_ROOT"
fi

if has_target hermes; then
  sync_root "$HERMES_HOME/skills"
fi

echo "Synced Matrix skills from $MATRIX_SKILLS_SOURCE."
