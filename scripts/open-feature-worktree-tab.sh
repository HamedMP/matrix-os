#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <number> <slug> [base-ref]" >&2
  echo "Example: $0 069 cloud-coding-workspaces" >&2
}

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  usage
  exit 2
fi

number="$1"
slug="$2"
base_ref="${3:-HEAD}"

if ! [[ "$number" =~ ^[0-9]{3}$ ]]; then
  echo "Feature number must be three digits, e.g. 069" >&2
  exit 2
fi

if ! [[ "$slug" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "Slug must match ^[a-z0-9][a-z0-9-]*$" >&2
  exit 2
fi

feature="${number}-${slug}"
repo_root="$(git rev-parse --show-toplevel)"
repo_parent="$(dirname "$repo_root")"
repo_name="$(basename "$repo_root")"
worktree_root="${repo_parent}/${repo_name}.worktrees"
worktree_dir="${worktree_root}/${feature}"

mkdir -p "$worktree_root"

if [ ! -d "$worktree_dir" ]; then
  if git show-ref --verify --quiet "refs/heads/${feature}"; then
    git worktree add "$worktree_dir" "$feature"
  else
    git worktree add -b "$feature" "$worktree_dir" "$base_ref"
  fi
fi

echo "Worktree: $worktree_dir"

if [ -n "${ZELLIJ:-}" ]; then
  zellij action new-tab --cwd "$worktree_dir" --name "$feature"
else
  echo "Not inside zellij. From a zellij pane, run:" >&2
  printf '  zellij action new-tab --cwd %q --name %q\n' "$worktree_dir" "$feature" >&2
fi
