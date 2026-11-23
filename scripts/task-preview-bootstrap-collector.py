#!/usr/bin/python3 -I
"""Task-only, fixed-command diagnostics. No owner files, HTTP, registration or startup writes."""
import json
import os
import re
import selectors
import signal
import stat
import subprocess
import sys
import time
from urllib.parse import unquote, urlsplit

GUARD = "/etc/matrix-preview-bootstrap-diag.json"
ENV_FILES = ("/opt/matrix/env/host.env", "/opt/matrix/env/registration.env", "/opt/matrix/env/postgres.env")
UNITS = ("cloud-init.service", "cloud-final.service", "docker.service", "matrix-restore.service", "matrix-scope-runtime.service", "matrix-gateway.service", "matrix-vps-registration.service", "matrix-terminal-runtime.service", "matrix-shell.service", "matrix-sync-agent.service")
MAX_BYTES = 96 * 1024
SENSITIVE = re.compile(r"token|secret|password|authorization|set-cookie|database_url|private.key|user.data|#cloud-config", re.I)


def read_fixed(path, maximum=65536, owner=0, private=False):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_mode & (0o077 if private else 0o022) or info.st_size > maximum:
            raise ValueError("Unsafe diagnostic input")
        raw = os.read(fd, maximum + 1)
        if len(raw) > maximum:
            raise ValueError("Diagnostic input too large")
        return raw.decode("utf-8")
    finally:
        os.close(fd)


def load_guard(path=GUARD, now=None, owner=0):
    guard = json.loads(read_fixed(path, 4096, owner, private=True))
    current = time.time() if now is None else now
    if guard.get("provisioningClass") != "preview" or guard.get("handle") != "pr-3482" or guard.get("runtimeSlot") != "pr-3482":
        raise ValueError("Preview identity required")
    if not re.fullmatch(r"user_[A-Za-z0-9_-]{1,123}", guard.get("ownerId", "")) or not re.fullmatch(r"[a-f0-9-]{36}", guard.get("machineId", "")):
        raise ValueError("Invalid diagnostic identity")
    if not re.fullmatch(r"[a-f0-9]{16,64}", guard.get("attemptId", "")):
        raise ValueError("Invalid diagnostic attempt")
    if not isinstance(guard.get("expiresAt"), int) or not isinstance(guard.get("issuedAt"), int) or not guard["issuedAt"] <= current < guard["expiresAt"] <= guard["issuedAt"] + 21600:
        raise ValueError("Diagnostic access expired")
    return guard


def environment(raw):
    return dict(line.split("=", 1) for line in raw.splitlines() if re.match(r"^[A-Z][A-Z0-9_]*=", line))


def identity_stage(guard, host_raw):
    if host_raw is None:
        return "rendered_guard_only"
    values = environment(host_raw)
    expected = {"MATRIX_HANDLE": guard["handle"], "MATRIX_RUNTIME_SLOT": guard["runtimeSlot"], "MATRIX_MACHINE_ID": guard["machineId"], "MATRIX_CLERK_USER_ID": guard["ownerId"], "MATRIX_PREVIEW_RUNTIME": "true"}
    if any(values.get(key) != value for key, value in expected.items()):
        raise ValueError("Guest identity mismatch")
    return "host_env"


def secret_values(raws):
    values = set()
    for raw in raws:
        for name, value in environment(raw).items():
            value = value.strip("\"'")
            if re.search(r"TOKEN|SECRET|PASSWORD|DATABASE_URL|AUTH_KEY", name) and 8 <= len(value) <= 8192:
                values.add(value)
                if name == "DATABASE_URL":
                    password = urlsplit(value).password
                    if password and len(password) >= 8:
                        values.add(unquote(password))
    return sorted(values, key=len, reverse=True)[:64]


def clean_text(text, secrets, latest=False):
    for value in secrets:
        text = text.replace(value, "[redacted]")
    text = re.sub(r"/home/matrix/home[^\s\"\']*", "[owner-path]", text)
    lines = []
    selected = text.splitlines()[-160:] if latest else text.splitlines()[:160]
    for line in selected:
        if SENSITIVE.search(line) or re.search(r"\b[A-Z][A-Z0-9_]{2,}=", line) or re.search(r"\b(?:Bearer\s+|eyJ[A-Za-z0-9_-]+\.|xox[baprs]-|sk-[A-Za-z0-9])", line):
            lines.append("[sensitive diagnostic line omitted]")
        else:
            lines.append(re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "?", line)[:768])
    encoded = "\n".join(lines).encode("utf-8")
    return (encoded[-12288:] if latest else encoded[:12288]).decode("utf-8", "ignore")


def run_bounded(argv, timeout=2, limit=65536):
    """Read incrementally; communicate() alone could allocate unbounded child output."""
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True,
                               env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8", "SYSTEMD_PAGER": "cat", "SYSTEMD_COLORS": "0"})
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    data = bytearray()
    deadline = time.monotonic() + timeout
    status = "ok"
    try:
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                status = "timeout"
                break
            for key, _ in selector.select(min(remaining, 0.1)):
                chunk = os.read(key.fileobj.fileno(), min(4096, limit + 1 - len(data)))
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                data.extend(chunk)
                if len(data) > limit:
                    status = "truncated"
                    break
            if status != "ok":
                break
        if status == "ok":
            process.wait(timeout=max(0.01, deadline - time.monotonic()))
            if process.returncode:
                status = "failed"
    except subprocess.TimeoutExpired:
        status = "timeout"
    finally:
        if process.poll() is None or status in ("timeout", "truncated"):
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        process.wait(timeout=1)
        selector.close()
        process.stdout.close()
    return status, process.returncode, bytes(data[:limit]).decode("utf-8", "replace")


def collect(guard, host_raw, secrets, runner=run_bounded):
    stage = identity_stage(guard, host_raw)
    commands = [
        ("cloud-init-status", ["/usr/bin/cloud-init", "status", "--format", "json"]),
        ("bootstrap-log", ["/usr/bin/tail", "--bytes=32768", "/var/log/cloud-init-output.log"]),
        ("service-state", ["/usr/bin/systemctl", "show", "--no-pager", "--property=Id,LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,ActiveEnterTimestampMonotonic,InactiveEnterTimestampMonotonic", *UNITS]),
        ("service-journal", ["/usr/bin/journalctl", "--no-pager", "--boot=0", "--lines=120", "--reverse", "--output=json", "--output-fields=MESSAGE,_SYSTEMD_UNIT", *[part for unit in UNITS for part in ("--unit", unit)]]),
    ]
    sections = []
    for name, argv in commands:
        try:
            status, code, text = runner(argv, timeout=2, limit=65536)
        except (OSError, subprocess.SubprocessError):
            status, code, text = "unavailable", None, ""
        if name == "cloud-init-status":
            try:
                raw = json.loads(text)
                text = json.dumps({key: raw[key] for key in ("status", "extended_status", "boot_status_code", "stage") if key in raw})
            except (ValueError, TypeError):
                text = "Status JSON unavailable"
        if name == "service-journal":
            messages = []
            for line in text.splitlines()[:120]:
                try:
                    item = json.loads(line)
                    unit = item.get("_SYSTEMD_UNIT")
                    if unit in UNITS and isinstance(item.get("MESSAGE"), str):
                        messages.append(f"{unit}: {item['MESSAGE']}")
                except (ValueError, TypeError):
                    continue
            text = "\n".join(messages)
        sections.append({"name": name, "status": status, "exitCode": code, "output": clean_text(text, secrets, latest=name == "bootstrap-log")})
    result = {"version": 1, "attemptId": guard["attemptId"], "identityMatched": True, "identityStage": stage, "identity": {key: guard[key] for key in ("ownerId", "machineId", "handle", "runtimeSlot", "provisioningClass")}, "sections": sections}
    encoded = json.dumps(result, ensure_ascii=True)
    if len(encoded.encode()) > MAX_BYTES:
        for section in sections:
            section["output"] = section["output"][-2048:] if section["name"] == "bootstrap-log" else section["output"][:2048]
        result["truncated"] = True
    return result


def main():
    if len(sys.argv) != 1 or os.geteuid() != 0 or os.environ.get("SSH_ORIGINAL_COMMAND"):
        raise ValueError("Fixed root collector required")
    guard = load_guard()
    raws = []
    host = None
    for path in ENV_FILES:
        try:
            raw = read_fixed(path)
            raws.append(raw)
            if path == ENV_FILES[0]:
                host = raw
        except FileNotFoundError:
            continue
    print(json.dumps(collect(guard, host, secret_values(raws)), ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print('{"version":1,"error":"Preview diagnostics unavailable"}')
        sys.exit(1)
