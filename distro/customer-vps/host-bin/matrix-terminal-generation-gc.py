#!/usr/bin/env python3
"""Print unreferenced terminal runtime generations eligible for deletion."""

import json
import os
import re
import sys

GENERATION_RE = re.compile(r"^gen_[0-9a-f]{64}$")


def main() -> int:
    if len(sys.argv) != 6:
        return 2
    root, descriptor_root, app_dir, rollback_dir, max_raw = sys.argv[1:]
    try:
        max_generations = int(max_raw)
    except ValueError:
        return 2
    if max_generations < 2 or max_generations > 32:
        return 2

    keep: set[str] = set()

    def keep_marker(directory: str) -> None:
        path = os.path.join(directory, "TERMINAL_RUNTIME_GENERATION")
        try:
            stats = os.lstat(path)
            if not os.path.isfile(path) or os.path.islink(path) or stats.st_size > 256:
                return
            with open(path, "r", encoding="utf-8") as handle:
                value = handle.read().strip()
            if GENERATION_RE.fullmatch(value):
                keep.add(value)
        except OSError:
            return

    keep_marker(app_dir)
    keep_marker(rollback_dir)
    try:
        current = os.readlink(os.path.join(root, "current"))
        current_name = os.path.basename(current)
        if GENERATION_RE.fullmatch(current_name):
            keep.add(current_name)
    except OSError:
        pass

    try:
        for entry in os.scandir(descriptor_root):
            if entry.is_symlink() or not entry.is_file(follow_symlinks=False):
                continue
            try:
                if entry.stat(follow_symlinks=False).st_size > 65536:
                    continue
                with open(entry.path, "r", encoding="utf-8") as handle:
                    generation = json.load(handle).get("generation")
                if isinstance(generation, str) and GENERATION_RE.fullmatch(generation):
                    keep.add(generation)
            except (OSError, ValueError, AttributeError):
                continue
    except OSError:
        pass

    generations: list[tuple[int, str]] = []
    generation_root = os.path.join(root, "generations")
    try:
        for entry in os.scandir(generation_root):
            if entry.is_symlink() or not entry.is_dir(follow_symlinks=False):
                continue
            if not GENERATION_RE.fullmatch(entry.name):
                continue
            generations.append((entry.stat(follow_symlinks=False).st_mtime_ns, entry.name))
    except OSError:
        pass

    remaining = len(generations)
    for _mtime, name in sorted(generations):
        if remaining <= max_generations:
            break
        if name in keep:
            continue
        print(name)
        remaining -= 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
