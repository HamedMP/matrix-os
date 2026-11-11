"""Mount Gateway-attested Claude replay bytes inside the scoped child."""

import fcntl
import os
import stat
import sys


MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024
SEALS = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SEAL


def protected_directory(path):
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError("invalid helper")
    directory = parent = os.path.dirname(path)
    while parent != "/":
        info = os.lstat(parent)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("invalid helper directory")
        parent = os.path.dirname(parent)
    return directory


def main():
    command, *args = sys.argv[1:]
    if not os.path.isabs(command):
        raise ValueError("invalid executable")
    cwd = os.getcwd()
    input_root = protected_directory(os.path.abspath(__file__))

    snapshot = os.memfd_create("matrix-claude-recovery", os.MFD_ALLOW_SEALING | os.MFD_CLOEXEC)
    size = 0
    with os.fdopen(3, "rb") as source, os.fdopen(snapshot, "wb", closefd=False) as output:
        while chunk := source.read(65536):
            size += len(chunk)
            if size > MAX_TRANSCRIPT_BYTES:
                raise ValueError("snapshot too large")
            output.write(chunk)
    if not size:
        raise ValueError("snapshot missing")
    fcntl.fcntl(snapshot, fcntl.F_ADD_SEALS, SEALS)
    if fcntl.fcntl(snapshot, fcntl.F_GET_SEALS) != SEALS:
        raise ValueError("snapshot sealing failed")
    os.lseek(snapshot, 0, os.SEEK_SET)
    os.dup2(snapshot, 3, inheritable=True)
    os.close(snapshot)

    # The pinned CLI excludes durable project inventory when project-config-root
    # is set. Its actual cwd and its project-config root stay the original path.
    # The alias retains the original sealed inode instead of copying its bytes.
    anchor = os.path.join(input_root, "resume.jsonl")
    os.execv("/usr/bin/bwrap", [
        "/usr/bin/bwrap", "--bind", "/", "/", "--tmpfs", input_root,
        "--symlink", "/proc/self/fd/3", anchor, "--remount-ro", input_root,
        "--chdir", cwd, "--die-with-parent", "--", command, *args, "--project-config-root", cwd,
        "--no-session-persistence", "--mcp-config", '{"mcpServers":{}}', "--resume", anchor,
    ])


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError):
        sys.exit("Protected Claude recovery unavailable")
