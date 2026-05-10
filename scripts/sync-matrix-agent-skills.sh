#!/usr/bin/env bash
set -euo pipefail

matrix_home="${1:-${MATRIX_HOME:-/home/matrixos/home}}"
shift || true

target_homes=("$@")
if [ "${#target_homes[@]}" -eq 0 ]; then
  target_homes=("${HOME:-/home/matrixos}" "$matrix_home")
fi

declare -a skill_names=()
declare -a skill_sources=()

set_skill_source() {
  local name="$1"
  local source="$2"
  local i
  for i in "${!skill_names[@]}"; do
    if [ "${skill_names[$i]}" = "$name" ]; then
      skill_sources[$i]="$source"
      return 0
    fi
  done
  skill_names+=("$name")
  skill_sources+=("$source")
}

add_flat_skills() {
  local dir="$matrix_home/agents/skills"
  [ -d "$dir" ] || return 0
  local skill name
  for skill in "$dir"/*.md; do
    [ -f "$skill" ] || continue
    name="$(basename "$skill" .md)"
    set_skill_source "$name" "$skill"
  done
}

add_directory_skills() {
  local dir="$matrix_home/.agents/skills"
  [ -d "$dir" ] || return 0
  local skill_dir name skill
  for skill_dir in "$dir"/*; do
    [ -d "$skill_dir" ] || continue
    skill="$skill_dir/SKILL.md"
    [ -f "$skill" ] || continue
    name="$(basename "$skill_dir")"
    set_skill_source "$name" "$skill_dir"
  done
}

cleanup_matrix_skills() {
  local skills_root="$1"
  mkdir -p "$skills_root"
  local generated name legacy
  for generated in "$skills_root"/matrix-*; do
    [ -e "$generated" ] || continue
    [ -f "$generated/.matrix-os-managed" ] && rm -rf "$generated"
  done
  for name in "${skill_names[@]}"; do
    legacy="$skills_root/$name"
    if [ -f "$legacy/SKILL.md" ] && grep -qxF "name: matrix-$name" "$legacy/SKILL.md"; then
      rm -rf "$legacy"
    elif [ -f "$legacy/agents/openai.yaml" ] && grep -q 'display_name: "Matrix:' "$legacy/agents/openai.yaml"; then
      rm -rf "$legacy"
    fi
  done
}

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[&\\/]/\\&/g'
}

write_claude_skill() {
  local skills_root="$1"
  local name="$2"
  local source="$3"
  local out="$skills_root/matrix-$name"
  local safe_name skill_file="$source"
  mkdir -p "$out"
  if [ -d "$source" ]; then
    cp -a "$source/." "$out/"
    rm -f "$out/.matrix-os-template-sha256"
    skill_file="$source/SKILL.md"
  fi
  safe_name="$(escape_sed_replacement "$name")"
  sed "s/^name: .*/name: matrix-$safe_name/" "$skill_file" > "$out/SKILL.md"
  touch "$out/.matrix-os-managed"
}

write_codex_skill() {
  local skills_root="$1"
  local name="$2"
  local source="$3"
  local out="$skills_root/matrix-$name"
  local safe_name display desc short_desc prompt_desc skill_file="$source"
  mkdir -p "$out"
  if [ -d "$source" ]; then
    cp -a "$source/." "$out/"
    rm -f "$out/.matrix-os-template-sha256"
    skill_file="$source/SKILL.md"
  fi
  mkdir -p "$out/agents"
  safe_name="$(escape_sed_replacement "$name")"
  sed "s/^name: .*/name: matrix-$safe_name/" "$skill_file" > "$out/SKILL.md"
  touch "$out/.matrix-os-managed"
  display="$(echo "$name" | tr '-' ' ' | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) substr($i,2)}1')"
  desc="$(sed -n 's/^description: *//p' "$skill_file" | head -1)"
  short_desc="$(printf '%s' "${desc:-$display skill}" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  prompt_desc="$(printf '%s' "${desc:-this task}" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  cat > "$out/agents/openai.yaml" <<EOYAML
interface:
  display_name: "Matrix: $display"
  short_description: "$short_desc"
  default_prompt: "Use \$matrix-$name for $prompt_desc."
EOYAML
}

add_flat_skills
add_directory_skills

for target_home in "${target_homes[@]}"; do
  [ -n "$target_home" ] || continue
  claude_root="$target_home/.claude/skills"
  codex_root="$target_home/.codex/skills"
  cleanup_matrix_skills "$claude_root"
  cleanup_matrix_skills "$codex_root"

  for i in "${!skill_names[@]}"; do
    name="${skill_names[$i]}"
    source="${skill_sources[$i]}"
    write_claude_skill "$claude_root" "$name" "$source"
    write_codex_skill "$codex_root" "$name" "$source"
  done
done

echo "Synced ${#skill_names[@]} Matrix skills into Claude Code and Codex skill directories."
