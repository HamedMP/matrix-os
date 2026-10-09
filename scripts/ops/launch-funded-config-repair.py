"""Trusted stdlib bootstrap: execute only independently pinned, sealed Node bytes.

Never invoke sudo on a binary beneath the writable Matrix runtime hierarchy.
This source is sent inline, not installed; CLI paths and inherited fds are fixed.
"""
import fcntl
import grp
import hashlib
import os
import re
import stat
import sys
import time


def require(condition, message):
    if not condition:
        raise ValueError(message)


def verify_chain(fds, parts, uid, gid, runtime=False):
    for index, fd in enumerate(fds):
        info = os.fstat(fd)
        name = None if index == 0 else parts[index - 1]
        writable = (name == "matrix" and stat.S_IMODE(info.st_mode) == 0o770)
        writable |= runtime and name in ("runtime", "node", "bin")
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == uid
                and not info.st_mode & 0o002
                and (not info.st_mode & 0o020 or (writable and info.st_gid == gid)), "unsafe directory")
        if name == "env":
            require(info.st_gid == gid and stat.S_IMODE(info.st_mode) == 0o750, "unsafe env directory")
        if index:
            current = os.stat(name, dir_fd=fds[index - 1], follow_symlinks=False)
            require(stat.S_ISDIR(current.st_mode) and (current.st_dev, current.st_ino) == (info.st_dev, info.st_ino), "directory rebound")


def open_chain(base, parts, uid, gid, runtime=False):
    fds = []
    try:
        fds.append(os.open(base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW))
        for part in parts:
            fds.append(os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fds[-1]))
        verify_chain(fds, parts, uid, gid, runtime)
        return fds
    except BaseException:
        for fd in fds:
            os.close(fd)
        raise


def snapshot_node(fd, expected_sha, maximum=268435456):
    require(isinstance(expected_sha, str) and re.fullmatch(r"[a-f0-9]{64}", expected_sha), "missing pinned digest")
    info = os.fstat(fd)
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and 0 < info.st_size <= maximum, "unsafe binary")
    data, deadline = bytearray(), time.monotonic() + 10
    while len(data) <= maximum:
        require(time.monotonic() < deadline, "binary read timeout")
        chunk = os.read(fd, min(1048576, maximum + 1 - len(data)))
        if not chunk:
            break
        data.extend(chunk)
    after = os.fstat(fd)
    require(len(data) <= maximum and (info.st_size, info.st_mtime_ns, info.st_ctime_ns)
            == (after.st_size, after.st_mtime_ns, after.st_ctime_ns), "binary changed")
    require(hashlib.sha256(data).hexdigest() == expected_sha, "binary digest mismatch")
    require(hasattr(os, "memfd_create"), "sealed execution unavailable")
    sealed = os.memfd_create("matrix-repair-node", os.MFD_ALLOW_SEALING)
    try:
        view = memoryview(data)
        while view:
            written = os.write(sealed, view)
            require(written > 0, "binary write failed")
            view = view[written:]
        fcntl.fcntl(sealed, fcntl.F_ADD_SEALS, fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL)
        return sealed
    except BaseException:
        os.close(sealed)
        raise


def inherit_environment(fds, host_fd):
    # Duplicate above the reserved range first; fd3/4/5/6 may currently belong
    # to different chain members. Never close/reuse one before duplicating all.
    held = [fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 10) for fd in (fds[-1], host_fd, fds[1], fds[2])]
    try:
        for target, source in zip((3, 4, 5, 6), held):
            os.dup2(source, target, inheritable=True)
    finally:
        for fd in held:
            os.close(fd)


def clean_environment():
    return {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}


def main():
    require(os.geteuid() == 0 and 4 <= len(sys.argv) <= 64, "invalid invocation")
    gid = grp.getgrnam("matrix").gr_gid
    env = open_chain("/", ("opt", "matrix", "env"), 0, gid)
    runtime = open_chain("/", ("opt", "matrix", "runtime", "node", "bin"), 0, gid, True)
    host = os.open("host.env", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=env[-1])
    host_info = os.fstat(host)
    require(stat.S_ISREG(host_info.st_mode) and host_info.st_nlink == 1 and host_info.st_uid == 0
            and host_info.st_gid == gid and stat.S_IMODE(host_info.st_mode) == 0o640 and host_info.st_size <= 65536, "unsafe env file")
    node = os.open("node", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=runtime[-1])
    info = os.fstat(node)
    require(info.st_uid == 0 and info.st_gid == gid and not info.st_mode & 0o6002 and info.st_mode & 0o100, "unsafe binary owner/mode")
    sealed = snapshot_node(node, sys.argv[1])
    # Preserve the executable above the fd slots about to be assigned.
    executable = fcntl.fcntl(sealed, fcntl.F_DUPFD_CLOEXEC, 10)
    verify_chain(runtime, ("opt", "matrix", "runtime", "node", "bin"), 0, gid, True)
    verify_chain(env, ("opt", "matrix", "env"), 0, gid)
    inherit_environment(env, host)
    keep = {0, 1, 2, 3, 4, 5, 6, executable}
    for fd in set(env + runtime + [host, node, sealed]) - keep:
        os.close(fd)
    loader = "require('node:vm').runInThisContext(require('node:zlib').inflateSync(Buffer.from(process.argv[1],'base64'),{maxOutputLength:32768}).toString('utf8'))"
    os.execve(executable, ["node", "-e", loader, "--", *sys.argv[2:]], clean_environment())


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print('{"error":"transport_failed"}', file=sys.stderr)
        sys.exit(1)
