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
    node - "$1" <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const root = fs.realpathSync(process.argv[2]);
const metadata = path.join(root, '.specify', 'feature.json');
let value = process.env.SPECIFY_FEATURE_DIRECTORY;
try {
    if (!value && process.env.SPECIFY_FEATURE) {
        const match = /^([0-9]{3,})-[a-zA-Z0-9_-]+$/.exec(process.env.SPECIFY_FEATURE);
        if (!match) throw new Error('selector');
        const specs = path.join(root, 'specs');
        const matches = fs.readdirSync(specs).filter(name => name.startsWith(match[1] + '-')
            && fs.statSync(path.join(specs, name)).isDirectory());
        if (matches.length !== 1) throw new Error('selector');
        value = path.join(specs, matches[0]);
    }
    if (!value) {
        let stat;
        try { stat = fs.lstatSync(metadata); }
        catch (error) { if (error.code === 'ENOENT') process.exit(3); throw error; }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('metadata');
        value = JSON.parse(fs.readFileSync(metadata, 'utf8')).feature_directory;
    }
    if (typeof value !== 'string' || !value || value.length > 4096
        || /[\0\n\r]/.test(value) || value.split(/[\\/]/).includes('..')) throw new Error('directory');
    const specs = fs.realpathSync(path.join(root, 'specs'));
    const selected = fs.realpathSync(path.resolve(root, value));
    const inside = (base, target) => {
        const relative = path.relative(base, target);
        return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    };
    if (!inside(root, specs) || !inside(specs, selected) || !fs.statSync(selected).isDirectory()
        || !fs.statSync(path.join(selected, 'spec.md')).isFile()) throw new Error('boundary');
    process.stdout.write(selected + '\n');
} catch (error) {
    process.stderr.write('ERROR: Invalid feature directory; select an existing specification inside specs/\n');
    process.exit(1);
}
JS
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

