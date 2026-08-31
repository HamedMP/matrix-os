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

if [ ! -d "$MATRIX_SKILLS_SOURCE" ]; then
  echo "Matrix skills source not found: $MATRIX_SKILLS_SOURCE" >&2
  exit 1
fi

MATRIX_SKILLS_SOURCE="$(cd "$MATRIX_SKILLS_SOURCE" && pwd)"
MATRIX_HOME="${MATRIX_HOME:-$HOME/matrixos}"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
MATRIX_SKILL_TARGETS=",${MATRIX_SKILL_TARGETS:-matrix,claude,codex},"
MANAGED_SKILLS_MANIFEST=".matrix-os-managed-skills"

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
  local path="$1"
  if [ -L "$path" ]; then
    local resolved
    resolved="$(realpath "$path" 2>/dev/null || true)"
    case "$resolved" in
      "$MATRIX_SKILLS_SOURCE"/*) return 0 ;;
    esac
    return 1
  fi
  [ -f "$path/.matrix-os-managed" ] && return 0
  [ -f "$path/SKILL.md" ] && grep -q '^[[:space:]]*author:[[:space:]]*Matrix OS[[:space:]]*$' "$path/SKILL.md" && return 0
  return 1
}

cleanup_root() {
  local root="$1"
  mkdir -p "$root"
  local manifest="$root/$MANAGED_SKILLS_MANIFEST"
  if [ -f "$manifest" ]; then
    while IFS='|' read -r managed_name managed_source; do
      case "$managed_name" in
        ""|*[!A-Za-z0-9._-]*) continue ;;
      esac
      local managed_path="$root/$managed_name"
      if [ -L "$managed_path" ] && [ "$(readlink "$managed_path" 2>/dev/null || true)" = "$managed_source" ]; then
        rm -f "$managed_path"
      elif [ -d "$managed_path" ] && [ -f "$managed_path/.matrix-os-managed" ]; then
        rm -rf "$managed_path"
      fi
    done < "$manifest"
  fi
  for generated in "$root"/matrix-*; do
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
      return 1
    fi
  fi

  if ln -s "$src" "$target" 2>/dev/null; then
    return 0
  fi

  cp -a "$src" "$target"
  touch "$target/.matrix-os-managed"
}

sync_root() {
  local root="$1"
  cleanup_root "$root"
  local manifest="$root/$MANAGED_SKILLS_MANIFEST"
  local manifest_tmp="$manifest.tmp.$$"
  : > "$manifest_tmp"

  for src in "$MATRIX_SKILLS_SOURCE"/*; do
    [ -d "$src" ] || continue
    [ -f "$src/SKILL.md" ] || continue
    local name
    name="$(skill_name "$src")"
    if [ -z "$name" ]; then
      name="matrix-$(basename "$src")"
    fi
    case "$name" in
      ""|*[!A-Za-z0-9._-]*)
        echo "Skipping skill with unsafe name: $name" >&2
        continue
        ;;
    esac
    if link_or_copy_skill "$src" "$root" "$name"; then
      printf '%s|%s\n' "$name" "$src" >> "$manifest_tmp"
    fi
  done
  mv "$manifest_tmp" "$manifest"
}

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

if has_target hermes; then
  sync_root "$HERMES_HOME/skills"
fi

echo "Synced Matrix skills from $MATRIX_SKILLS_SOURCE."
