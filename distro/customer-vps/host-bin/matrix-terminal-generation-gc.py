#!/usr/bin/env python3
"""Inspect or delete unreferenced terminal runtime generations safely."""

import fcntl
import json
import os
import re
import shutil
import stat
import sys

GENERATION_RE = re.compile(r"^gen_[0-9a-f]{64}$")


def ensure_descriptor_root(descriptor_root: str) -> None:
    """Create only the final owner metadata directory without following symlinks."""
    normalized = os.path.abspath(descriptor_root)
    parent = os.path.dirname(normalized)
    name = os.path.basename(normalized)
    if not name or name in {".", ".."}:
        raise OSError("unsafe descriptor root")

    parent_stats = os.lstat(parent)
    if stat.S_ISLNK(parent_stats.st_mode) or not stat.S_ISDIR(parent_stats.st_mode):
        raise OSError("unsafe descriptor parent")
    parent_descriptor = os.open(
        parent,
        os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW,
    )
    created = False
    try:
        try:
            os.mkdir(name, 0o700, dir_fd=parent_descriptor)
            created = True
        except FileExistsError:
            pass
        descriptor = os.open(
            name,
            os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW,
            dir_fd=parent_descriptor,
        )
        try:
            root_stats = os.fstat(descriptor)
            if not stat.S_ISDIR(root_stats.st_mode):
                raise OSError("unsafe descriptor root")
            if created:
                if os.geteuid() == 0:
                    os.fchown(descriptor, parent_stats.st_uid, parent_stats.st_gid)
                os.fchmod(descriptor, 0o700)
        finally:
            os.close(descriptor)
    finally:
        os.close(parent_descriptor)


def acquire_generation_lock(descriptor_root: str) -> int:
    root_stats = os.lstat(descriptor_root)
    if stat.S_ISLNK(root_stats.st_mode) or not stat.S_ISDIR(root_stats.st_mode):
        raise OSError("unsafe descriptor root")
    lock_path = os.path.join(descriptor_root, ".generation-gc.lock")
    descriptor = os.open(
        lock_path,
        os.O_CREAT | os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW,
        0o600,
    )
    try:
        lock_stats = os.fstat(descriptor)
        if not stat.S_ISREG(lock_stats.st_mode):
            raise OSError("unsafe generation lock")
        if lock_stats.st_uid != root_stats.st_uid or lock_stats.st_gid != root_stats.st_gid:
            if os.geteuid() != 0:
                raise OSError("generation lock ownership mismatch")
            os.fchown(descriptor, root_stats.st_uid, root_stats.st_gid)
        os.fchmod(descriptor, 0o600)
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def collect_candidates(
    root: str,
    descriptor_root: str,
    app_dir: str,
    rollback_dir: str,
    max_raw: str,
) -> list[str]:
    try:
        max_generations = int(max_raw)
    except ValueError:
        raise OSError("invalid generation limit")
    if max_generations < 2 or max_generations > 32:
        raise OSError("invalid generation limit")

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

    candidates: list[str] = []
    remaining = len(generations)
    for _mtime, name in sorted(generations):
        if remaining <= max_generations:
            break
        if name in keep:
            continue
        candidates.append(name)
        remaining -= 1
    return candidates


def delete_candidates(root: str, candidates: list[str]) -> None:
    generation_root = os.path.join(root, "generations")
    for name in candidates:
        if not GENERATION_RE.fullmatch(name):
            raise OSError("invalid generation candidate")
        candidate = os.path.join(generation_root, name)
        stats = os.lstat(candidate)
        if stat.S_ISLNK(stats.st_mode) or not stat.S_ISDIR(stats.st_mode):
            raise OSError("unsafe generation candidate")
        shutil.rmtree(candidate)
        print(name, flush=True)


def main() -> int:
    if len(sys.argv) == 3 and sys.argv[1] == "--lock":
        try:
            descriptor = acquire_generation_lock(sys.argv[2])
            print("locked", flush=True)
            sys.stdin.buffer.read(1)
            os.close(descriptor)
            return 0
        except OSError:
            return 1

    delete = len(sys.argv) == 7 and sys.argv[1] == "--delete"
    if delete:
        root, descriptor_root, app_dir, rollback_dir, max_raw = sys.argv[2:]
    elif len(sys.argv) == 6:
        root, descriptor_root, app_dir, rollback_dir, max_raw = sys.argv[1:]
    else:
        return 2
    descriptor: int | None = None
    try:
        if delete:
            ensure_descriptor_root(descriptor_root)
            descriptor = acquire_generation_lock(descriptor_root)
        candidates = collect_candidates(root, descriptor_root, app_dir, rollback_dir, max_raw)
        if delete:
            delete_candidates(root, candidates)
        else:
            for candidate in candidates:
                print(candidate)
    except OSError:
        return 1
    finally:
        if descriptor is not None:
            os.close(descriptor)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
