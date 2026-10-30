#!/usr/bin/env bash
# Common functions and variables for all scripts

# Get repository root, with fallback for non-git repositories
get_repo_root() {
    if git rev-parse --show-toplevel >/dev/null 2>&1; then
        git rev-parse --show-toplevel
    else
        # Fall back to script location for non-git repos
        local script_dir="$(CDPATH="" cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
        (cd "$script_dir/../../.." && pwd)
    fi
}

# Get current branch, with fallback for non-git repositories
get_current_branch() {
    # First check if SPECIFY_FEATURE environment variable is set
    if [[ -n "${SPECIFY_FEATURE:-}" ]]; then
        echo "$SPECIFY_FEATURE"
        return
    fi

    # Then check git if available
    if git rev-parse --abbrev-ref HEAD >/dev/null 2>&1; then
        git rev-parse --abbrev-ref HEAD
        return
    fi

    # For non-git repos, try to find the latest feature directory
    local repo_root=$(get_repo_root)
    local specs_dir="$repo_root/specs"

    if [[ -d "$specs_dir" ]]; then
        local latest_feature=""
        local highest=0

        for dir in "$specs_dir"/*; do
            if [[ -d "$dir" ]]; then
                local dirname=$(basename "$dir")
                if [[ "$dirname" =~ ^([0-9]{3,})- ]]; then
                    local number=${BASH_REMATCH[1]}
                    number=$((10#$number))
                    if [[ "$number" -gt "$highest" ]]; then
                        highest=$number
                        latest_feature=$dirname
                    fi
                fi
            fi
        done

        if [[ -n "$latest_feature" ]]; then
            echo "$latest_feature"
            return
        fi
    fi

    echo "main"  # Final fallback
}

# Check if we have git available
has_git() {
    git rev-parse --show-toplevel >/dev/null 2>&1
}

check_feature_branch() {
    local branch="$1"
    local has_git_repo="$2"

    # For non-git repos, we can't enforce branch naming but still provide output
    if [[ "$has_git_repo" != "true" ]]; then
        echo "[specify] Warning: Git repository not detected; skipped branch validation" >&2
        return 0
    fi

    # A validated directory selection is independent of a stack branch's name.
    if [[ "${FEATURE_SELECTION_EXPLICIT:-false}" == "true" ]]; then
        return 0
    fi

    if [[ ! "$branch" =~ ^[0-9]{3,}- ]]; then
        echo "ERROR: Not on a feature branch. Current branch: $branch" >&2
        echo "Feature branches should be named like: 001-feature-name" >&2
        return 1
    fi

    return 0
}

get_feature_dir() { echo "$1/specs/$2"; }

# Find feature directory by numeric prefix instead of exact branch match
# This allows multiple branches to work on the same spec (e.g., 004-fix-bug, 004-add-feature)
find_feature_dir_by_prefix() {
    local repo_root="$1"
    local branch_name="$2"
    local specs_dir="$repo_root/specs"

    # Extract numeric prefix from branch (e.g., "004" from "004-whatever")
    if [[ ! "$branch_name" =~ ^([0-9]{3,})- ]]; then
        # If branch doesn't have numeric prefix, fall back to exact match
        echo "$specs_dir/$branch_name"
        return
    fi

    local prefix="${BASH_REMATCH[1]}"

    # Search for directories in specs/ that start with this prefix
    local matches=()
    if [[ -d "$specs_dir" ]]; then
        for dir in "$specs_dir"/"$prefix"-*; do
            if [[ -d "$dir" ]]; then
                matches+=("$(basename "$dir")")
            fi
        done
    fi

    # Handle results
    if [[ ${#matches[@]} -eq 0 ]]; then
        # No match found - return the branch name path (will fail later with clear error)
        echo "$specs_dir/$branch_name"
    elif [[ ${#matches[@]} -eq 1 ]]; then
        # Exactly one match - perfect!
        echo "$specs_dir/${matches[0]}"
    else
        # Multiple matches - this shouldn't happen with proper naming convention
        echo "ERROR: Multiple spec directories found with prefix '$prefix': ${matches[*]}" >&2
        echo "Please ensure only one spec directory exists per numeric prefix." >&2
        return 1
    fi
}

# Exit 3 means no explicit selection; malformed selections must never fall back.
resolve_specified_feature_dir() {
    python3 - "$1" <<'PY'
import json, os, re, sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
metadata = root / ".specify" / "feature.json"
value = os.environ.get("SPECIFY_FEATURE_DIRECTORY")
try:
    if not value and os.environ.get("SPECIFY_FEATURE"):
        selector = os.environ["SPECIFY_FEATURE"]
        match = re.fullmatch(r"([0-9]{3,})-[a-zA-Z0-9_-]+", selector)
        if not match:
            raise ValueError("selector")
        matches = [path for path in (root / "specs").glob(match[1] + "-*") if path.is_dir()]
        if len(matches) != 1:
            raise ValueError("selector")
        value = str(matches[0])
    if not value:
        if metadata.is_symlink():
            raise ValueError("metadata")
        if not metadata.exists():
            sys.exit(3)
        if metadata.stat().st_size > 65536:
            raise ValueError("metadata")
        value = json.loads(metadata.read_text())["feature_directory"]
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise ValueError("directory")
    if any(char in value for char in ("\0", "\n", "\r")) or ".." in Path(value).parts:
        raise ValueError("directory")
    specs = (root / "specs").resolve()
    selected = (root / value).resolve()
    if not specs.is_relative_to(root) or selected == specs or not selected.is_relative_to(specs):
        raise ValueError("boundary")
    if not selected.is_dir() or not (selected / "spec.md").is_file():
        raise ValueError("missing specification")
except (OSError, ValueError, TypeError, KeyError):
    print("ERROR: Invalid feature directory; select an existing specification inside specs/", file=sys.stderr)
    sys.exit(1)
print(selected)
PY
}

get_feature_paths() {
    local repo_root=$(get_repo_root)
    local current_branch=$(get_current_branch)
    local has_git_repo="false"

    if has_git; then
        has_git_repo="true"
    fi

    local feature_dir selection_status=0 explicit=false
    feature_dir=$(resolve_specified_feature_dir "$repo_root") || selection_status=$?
    if [[ "$selection_status" == 0 ]]; then
        explicit=true
    elif [[ "$selection_status" == 3 ]]; then
        feature_dir=$(find_feature_dir_by_prefix "$repo_root" "$current_branch") || return 1
    else
        return "$selection_status"
    fi

    # Callers evaluate these assignments; quote values rather than executable text.
    printf '%s=%q\n' \
        REPO_ROOT "$repo_root" CURRENT_BRANCH "$current_branch" HAS_GIT "$has_git_repo" \
        FEATURE_SELECTION_EXPLICIT "$explicit" FEATURE_DIR "$feature_dir" \
        FEATURE_SPEC "$feature_dir/spec.md" IMPL_PLAN "$feature_dir/plan.md" \
        TASKS "$feature_dir/tasks.md" RESEARCH "$feature_dir/research.md" \
        DATA_MODEL "$feature_dir/data-model.md" QUICKSTART "$feature_dir/quickstart.md" \
        CONTRACTS_DIR "$feature_dir/contracts"
}

check_file() { [[ -f "$1" ]] && echo "  ✓ $2" || echo "  ✗ $2"; }
check_dir() { [[ -d "$1" && -n $(ls -A "$1" 2>/dev/null) ]] && echo "  ✓ $2" || echo "  ✗ $2"; }

