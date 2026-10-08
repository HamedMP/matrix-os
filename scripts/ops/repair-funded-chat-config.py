#!/usr/bin/python3 -I
"""Operator-only repair. Bounded stdin JSON; no secrets in argv or receipts.

No restart, network call, user-home write, grant, epoch rotation or installation.
A coordinated writer/idle window is REQUIRED: this lock covers only this tool.
"""
import base64
import fcntl
import hashlib
import ipaddress
import json
import os
import re
import secrets
import stat
import sys
from urllib.parse import urlsplit

LIMIT = 65536
INPUT_LIMIT = 4096
KEYS = {"MATRIX_FUNDED_AI_ENABLED", "MATRIX_FUNDED_AI_RELAY_URL",
        "MATRIX_FUNDED_AI_RUNTIME_TOKEN", "MATRIX_FUNDED_AI_PLATFORM_URL"}
IDENTITY = {"machineId": "MATRIX_MACHINE_ID", "ownerId": "MATRIX_CLERK_USER_ID",
            "handle": "MATRIX_HANDLE", "runtimeSlot": "MATRIX_RUNTIME_SLOT",
            "epoch": "MATRIX_RUNTIME_TOKEN_EPOCH"}
WATCHED = KEYS | set(IDENTITY.values()) | {"PLATFORM_INTERNAL_URL"}


class RepairError(Exception):
    def __init__(self, code):
        self.code = code


def require(condition, code="invalid_request"):
    if not condition:
        raise RepairError(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def parse(data):
    require(b"\x00" not in data and b"\r" not in data, "unsafe_env")
    lines = data.decode("utf-8").splitlines(keepends=True)
    values, raw = {}, {}
    for line in lines:
        match = re.match(r"\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=", line)
        if not match or match[1] not in WATCHED:
            continue
        key = match[1]
        require(key not in values and line.startswith(key + "="), "unsafe_env")
        value = line[len(key) + 1:].removesuffix("\n")
        # Managed/identity values have one literal representation; never source shell.
        require(re.fullmatch(r"[A-Za-z0-9_./:@%+~-]*", value) is not None, "unsafe_env")
        values[key], raw[key] = value, line
    return lines, values, raw


def service_url(value, origin=False):
    require(isinstance(value, str) and 1 <= len(value) <= 512)
    parsed = urlsplit(value)
    host = parsed.hostname or ""
    require(parsed.scheme == "https" and re.fullmatch(r"[a-z0-9.-]+", host)
            and "." in host and not parsed.username and not parsed.password
            and not parsed.query and not parsed.fragment and parsed.port in (None, 443)
            and "---" not in host and "preview" not in host and host != "localhost"
            and not host.endswith((".local", ".internal"))
            and re.fullmatch(r"[A-Za-z0-9_./~-]*", parsed.path) is not None
            and (not origin or parsed.path in ("", "/")))
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return value.rstrip("/")
    raise RepairError("invalid_request")


def validate(request):
    require(isinstance(request, dict))
    action = request.get("action")
    fields = {"action", "rolloutId", "identity", "expectedFile", "quiescentWindow"}
    require(action in ("apply", "rollback") and set(request) == fields | ({"config"} if action == "apply" else set()))
    require(request["quiescentWindow"] is True, "writer_window_required")
    require(isinstance(request["rolloutId"], str) and re.fullmatch(r"[a-z0-9-]{1,48}", request["rolloutId"]))
    identity = request["identity"]
    require(isinstance(identity, dict) and set(identity) == set(IDENTITY))
    require(identity["runtimeSlot"] == "primary")
    for key in ("machineId", "ownerId", "handle"):
        require(isinstance(identity[key], str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", identity[key]))
    require(type(identity["epoch"]) is int and 1 <= identity["epoch"] <= 2147483647)
    expected = request["expectedFile"]
    require(isinstance(expected, dict) and set(expected) == {"sha256", "inode", "device"})
    require(isinstance(expected["sha256"], str) and re.fullmatch(r"[a-f0-9]{64}", expected["sha256"]))
    require(all(type(expected[key]) is int and expected[key] >= 0 for key in ("inode", "device")))
    if action == "rollback":
        return {}
    config = request["config"]
    require(isinstance(config, dict) and {"relayUrl", "runtimeToken"} <= set(config)
            and set(config) <= {"relayUrl", "runtimeToken", "platformUrl"})
    require(isinstance(config["runtimeToken"], str) and re.fullmatch(r"[a-f0-9]{64}", config["runtimeToken"]))
    patch = {"MATRIX_FUNDED_AI_ENABLED": "true",
             "MATRIX_FUNDED_AI_RELAY_URL": service_url(config["relayUrl"]),
             "MATRIX_FUNDED_AI_RUNTIME_TOKEN": config["runtimeToken"]}
    if "platformUrl" in config:
        patch["MATRIX_FUNDED_AI_PLATFORM_URL"] = service_url(config["platformUrl"], True)
    return patch


def metadata(info, uid, gid, mode):
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
            and info.st_uid == uid and info.st_gid == gid
            and stat.S_IMODE(info.st_mode) == mode, "unsafe_file")


def read_file(directory, name, uid, gid, mode=0o640, limit=LIMIT):
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        before = os.fstat(descriptor)
        metadata(before, uid, gid, mode)
        require(before.st_size <= limit, "unsafe_file")
        data = b""
        while len(data) <= limit:
            chunk = os.read(descriptor, min(8192, limit + 1 - len(data)))
            if not chunk:
                break
            data += chunk
        after = os.fstat(descriptor)
        require(len(data) <= limit and fingerprint(before) == fingerprint(after), "file_conflict")
        return data, after
    finally:
        os.close(descriptor)


def fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns,
            info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode))


def verify_identity(values, identity):
    require(all(values.get(env_key) == str(identity[key]) for key, env_key in IDENTITY.items()), "identity_conflict")


def verify_expected(data, info, expected):
    require(sha(data) == expected["sha256"] and info.st_ino == expected["inode"]
            and info.st_dev == expected["device"], "file_conflict")


def rewrite(data, replacements):
    lines, _, _ = parse(data)
    result, seen = [], set()
    for line in lines:
        key = line.split("=", 1)[0]
        if key in replacements:
            if replacements[key] is not None:
                result.append(replacements[key].removesuffix("\n") + "\n")
            seen.add(key)
        else:
            result.append(line)
    additions = [replacements[key] for key in sorted(set(replacements) - seen)
                 if replacements[key] is not None]
    if additions and result and not result[-1].endswith("\n"):
        result[-1] += "\n"
    return "".join(result + additions).encode("utf-8")


def create_file(directory, name, data, uid, gid, mode, cleanup=False):
    descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
    try:
        os.fchown(descriptor, uid, gid)
        with os.fdopen(descriptor, "wb", closefd=False) as file:
            file.write(data)
            file.flush()
        os.fchmod(descriptor, mode)
        os.fsync(descriptor)
    except BaseException:
        if cleanup:
            os.unlink(name, dir_fd=directory)
        raise
    finally:
        os.close(descriptor)


def backup_name(rollout_id):
    return "host.env.funded-" + rollout_id + ".json"


def backup(directory, name, old, new, patch, identity, info, uid, private_gid):
    count = total = 0
    with os.scandir(directory) as entries:
        for entry in entries:
            total += 1
            count += entry.name.startswith("host.env.funded-") and entry.name.endswith(".json")
            require(total <= 128 and count < 32, "backup_capacity")
    journal = {"version": 1, "identity": identity, "original": base64.b64encode(old).decode(),
               "beforeSha256": sha(old), "afterSha256": sha(new), "patch": patch,
               "mode": stat.S_IMODE(info.st_mode), "uid": info.st_uid, "gid": info.st_gid}
    create_file(directory, name, json.dumps(journal, separators=(",", ":")).encode(), uid, private_gid, 0o600)
    os.fsync(directory)


def rollback_image(directory, name, data, values, identity, uid, private_gid, host_info):
    raw, _ = read_file(directory, name, uid, private_gid, 0o600, 131072)
    journal = json.loads(raw, object_pairs_hook=unique_object)
    require(isinstance(journal, dict) and set(journal) == {
        "version", "identity", "original", "beforeSha256", "afterSha256", "patch", "mode", "uid", "gid"}
        and journal["version"] == 1 and journal["identity"] == identity
        and journal["mode"] == stat.S_IMODE(host_info.st_mode)
        and journal["uid"] == host_info.st_uid and journal["gid"] == host_info.st_gid, "backup_conflict")
    old = base64.b64decode(journal["original"], validate=True)
    require(len(old) <= LIMIT and sha(old) == journal["beforeSha256"], "backup_conflict")
    _, original_values, original_lines = parse(old)
    verify_identity(original_values, identity)
    patch = journal["patch"]
    require(isinstance(patch, dict) and {"MATRIX_FUNDED_AI_ENABLED", "MATRIX_FUNDED_AI_RELAY_URL", "MATRIX_FUNDED_AI_RUNTIME_TOKEN"} <= set(patch) <= KEYS,
            "backup_conflict")
    require(patch["MATRIX_FUNDED_AI_ENABLED"] == "true"
            and isinstance(patch["MATRIX_FUNDED_AI_RUNTIME_TOKEN"], str)
            and re.fullmatch(r"[a-f0-9]{64}", patch["MATRIX_FUNDED_AI_RUNTIME_TOKEN"]), "backup_conflict")
    service_url(patch["MATRIX_FUNDED_AI_RELAY_URL"])
    if "MATRIX_FUNDED_AI_PLATFORM_URL" in patch:
        service_url(patch["MATRIX_FUNDED_AI_PLATFORM_URL"], True)
    post_image = rewrite(old, {key: key + "=" + value + "\n" for key, value in patch.items()})
    require(sha(post_image) == journal["afterSha256"], "backup_conflict")
    before = {key: original_values.get(key) for key in patch}
    now = {key: values.get(key) for key in patch}
    if now == before:
        return data
    require(now == patch, "funding_conflict")
    if sha(data) == journal["afterSha256"]:
        return old
    return rewrite(data, {key: original_lines.get(key) for key in patch})


def _execute(request, root, uid, gid, activity):
    patch = validate(request)
    private_gid = 0 if uid == 0 else gid  # Root CLI artifacts remain root:root.
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    lock = None
    try:
        info = os.fstat(directory)
        require(info.st_uid == uid and not info.st_mode & 0o022, "unsafe_directory")
        lock = os.open(".host.env.funded-repair.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                       0o600, dir_fd=directory)
        metadata(os.fstat(lock), uid, private_gid, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RepairError("repair_busy")
        activity()
        data, info = read_file(directory, "host.env", uid, gid)
        verify_expected(data, info, request["expectedFile"])
        _, values, _ = parse(data)
        verify_identity(values, request["identity"])
        name = backup_name(request["rolloutId"])
        if request["action"] == "apply":
            service_url(patch.get("MATRIX_FUNDED_AI_PLATFORM_URL",
                        values.get("MATRIX_FUNDED_AI_PLATFORM_URL", values.get("PLATFORM_INTERNAL_URL"))), True)
            if all(values.get(key) == value for key, value in patch.items()):
                new = data
            else:
                new = rewrite(data, {key: key + "=" + value + "\n" for key, value in patch.items()})
        else:
            new = rollback_image(directory, name, data, values, request["identity"], uid, private_gid, info)
        require(len(new) <= LIMIT, "unsafe_file")
        changed = new != data
        if changed:
            if request["action"] == "apply":
                backup(directory, name, data, new, patch, request["identity"], info, uid, private_gid)
            temporary = ".host.env.funded.tmp-" + secrets.token_hex(12)
            created = False
            try:
                create_file(directory, temporary, new, uid, gid, 0o640, cleanup=True)
                created = True
                activity()
                current, current_info = read_file(directory, "host.env", uid, gid)
                require(current == data and fingerprint(current_info) == fingerprint(info), "file_conflict")
                os.replace(temporary, "host.env", src_dir_fd=directory, dst_dir_fd=directory)
                os.fsync(directory)
            finally:
                if created:
                    try:
                        os.unlink(temporary, dir_fd=directory)
                    except FileNotFoundError:
                        pass  # Successful rename consumed this name.
        return {"action": request["action"], "changed": changed, "restartRequired": changed,
                "beforeSha256": sha(data), "afterSha256": sha(new), "backup": name if changed else None}
    finally:
        if lock is not None:
            os.close(lock)
        os.close(directory)


def execute(request, root, uid, gid, activity):
    try:
        return _execute(request, root, uid, gid, activity)
    except RepairError:
        raise
    except (OSError, ValueError, TypeError, KeyError, UnicodeError):
        raise RepairError("repair_failed") from None


def known_activity():
    for path in ("/opt/matrix/app/.update-now", "/opt/matrix/app/.update-repair-now",
                 "/opt/matrix/app/.rollback-now", "/opt/matrix/staging/update-phase",
                 "/opt/matrix/staging/update-transaction/state"):
        require(not os.path.lexists(path), "writer_busy")
    # The persistent idle sync daemon is not a writer-activity proof. Its markers
    # cover upgrades, not every legacy env edit; external coordination remains required.
    with os.scandir("/proc") as entries:
        count = 0
        for entry in entries:
            if not entry.name.isdigit() or int(entry.name) == os.getpid():
                continue
            count += 1
            require(count <= 8192, "writer_busy")
            try:
                with open(entry.path + "/cmdline", "rb") as file:
                    args = file.read(8192).split(b"\x00")
            except (FileNotFoundError, ProcessLookupError):
                continue
            names = {os.path.basename(arg) for arg in args}
            require(not names & {b"matrix-configure-platform-speech.py", b"matrix-rotate-runtime-tokens.py",
                                 b"matrix-update", b"cloud-init"}, "writer_busy")


def secure_ancestors():
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in ("opt", "matrix", "env"):
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
            info = os.fstat(descriptor)
            require(info.st_uid == 0 and not info.st_mode & 0o022, "unsafe_directory")
    finally:
        os.close(descriptor)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def main():
    import grp
    require(os.geteuid() == 0 and len(sys.argv) == 1, "root_required")
    data = sys.stdin.buffer.read(INPUT_LIMIT + 1)
    require(len(data) <= INPUT_LIMIT)
    request = json.loads(data, object_pairs_hook=unique_object)
    secure_ancestors()
    receipt = execute(request, "/opt/matrix/env", 0, grp.getgrnam("matrix").gr_gid, known_activity)
    print(json.dumps(receipt, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        code = error.code if isinstance(error, RepairError) else "repair_failed"
        print(json.dumps({"error": code}), file=sys.stderr)
        sys.exit(1)
