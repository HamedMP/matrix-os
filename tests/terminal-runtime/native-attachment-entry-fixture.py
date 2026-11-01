#!/usr/bin/env python3
"""Linux component tests for the actual fixed C entry, never source admission.

Usage: python3 native-attachment-entry-fixture.py SOURCE_ROOT EVIDENCE_ROOT
No network or dependency installation. The parent owns the Linux runner.
"""
import ctypes
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import selectors
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import time


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(argv, **kwargs):
    payload = kwargs.pop("input", b"")
    child = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, start_new_session=True, **kwargs)
    streams = {"stdout": bytearray(), "stderr": bytearray()}
    try:
        child.stdin.write(payload)
        child.stdin.close()
        deadline = time.monotonic() + 35
        with selectors.DefaultSelector() as selector:
            for name in streams:
                stream = getattr(child, name)
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, name)
            while selector.get_map():
                assert time.monotonic() < deadline, "subprocess deadline"
                for key, _ in selector.select(min(0.25, max(0, deadline - time.monotonic()))):
                    chunk = os.read(key.fd, 8192)
                    if not chunk:
                        selector.unregister(key.fileobj)
                    else:
                        streams[key.data].extend(chunk)
                        assert len(streams[key.data]) <= 65536, "subprocess output bound"
            child.wait(timeout=max(0.01, deadline - time.monotonic()))
        return subprocess.CompletedProcess(argv, child.returncode, bytes(streams["stdout"]), bytes(streams["stderr"]))
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=5)
        child.stdout.close()
        child.stderr.close()


def elf(path):
    data = path.read_bytes()
    assert data[:6] == b"\x7fELF\x02\x01", "requires ELF64 little endian"
    machine = struct.unpack_from("<H", data, 18)[0]
    assert machine == {"x86_64": 62, "aarch64": 183}[platform.machine()]
    phoff = struct.unpack_from("<Q", data, 32)[0]
    entsize, count = struct.unpack_from("<HH", data, 54)
    assert entsize >= 56 and count <= 1024
    assert phoff + entsize * count <= len(data)
    for i in range(count):
        kind, _, offset, _, _, size = struct.unpack_from("<IIQQQQ", data, phoff + i * entsize)
        assert kind != 3, "PT_INTERP forbidden"
        if kind == 2:
            assert offset + size <= len(data) and size % 16 == 0
            for at in range(offset, offset + size, 16):
                tag = struct.unpack_from("<q", data, at)[0]
                assert tag != 1, "DT_NEEDED forbidden"
                if tag == 0:
                    break
    return {"class": 64, "endian": "little", "machine": machine,
            "pt_interp": False, "dt_needed": False, "sha256": digest(path)}


def deny_syscalls(numbers):
    """Controlled child-only seccomp: exercise actual fallback/failure branches."""
    class Filter(ctypes.Structure):
        _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte),
                    ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint)]
    class Program(ctypes.Structure):
        _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(Filter))]
    instructions = [Filter(0x20, 0, 0, 0)]  # seccomp_data.nr
    for number in numbers:
        instructions.extend([Filter(0x15, 0, 1, number), Filter(0x06, 0, 0, 0x50000 | errno.ENOSYS)])
    instructions.append(Filter(0x06, 0, 0, 0x7fff0000))
    array = (Filter * len(instructions))(*instructions)
    program = Program(len(instructions), array)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) or libc.prctl(22, 2, ctypes.byref(program), 0, 0):
        raise OSError(ctypes.get_errno(), "fixture seccomp unavailable")


def main():
    source, evidence = map(lambda s: Path(s).resolve(), sys.argv[1:])
    evidence.mkdir(parents=True, exist_ok=False)
    results = {"scope": "actual C / component-only recording JS; no production JS closure or source admission",
               "platform": platform.platform(), "checks": [], "failures": []}

    def check(name, fn):
        try:
            detail = fn()
            results["checks"].append({"name": name, "pass": True, "detail": detail})
        except Exception as error:
            results["checks"].append({"name": name, "pass": False, "error": str(error)})
            results["failures"].append(name)

    native = source / "packages/gateway/native"
    c_source = native / "terminal-attachment-entry.c"
    builder = native / "build-terminal-attachment-entry.mjs"

    def prerequisite():
        assert sys.platform == "linux", "Linux required"
        assert platform.machine() in ("x86_64", "aarch64"), "supported arch required"
        assert c_source.is_file(), "APIabsence: C source missing"
        assert builder.is_file(), "APIabsence: explicit-output build entry missing"
        return {"source_sha256": digest(c_source), "build_sha256": digest(builder)}

    check("source_and_build_API_present", prerequisite)
    if not results["failures"]:
        with tempfile.TemporaryDirectory(prefix="attachment-entry-", dir="/tmp") as temporary:
            root = Path(temporary)
            generation, cwd, home = (root / name for name in ("generation", "cwd", "home"))
            for directory in (generation, cwd, home):
                directory.mkdir()
            node = Path(shutil.which("node") or "/usr/local/bin/node").resolve()
            shutil.copy2(node, generation / "node")
            binary = generation / "matrix-terminal-attachment-entry"
            public_io = "/tmp/matrix-terminal-0123456789abcdef0123456789abcdef/io.sock"
            # It records the real Node boundary; it intentionally does not implement
            # production generation validation or pretend to be a real attachment.
            recording_js = r'''
import fs from 'node:fs';
const links = [];
for (const fd of fs.readdirSync('/proc/self/fd').slice(0, 65536)) {
  try { links.push(fs.readlinkSync('/proc/self/fd/' + fd)); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}
const input = fs.readFileSync(0, 'utf8');
fs.writeSync(1, JSON.stringify({argv: process.argv, env: process.env,
  cwd: process.cwd(), pid: process.pid, links, input}) + '\n');
fs.writeSync(2, 'fixture-stderr\n');
process.exit(7);
'''
            js = generation / "terminal-io-attach.mjs"
            js.write_text(recording_js)

            def build():
                result = run([str(node), str(builder), str(binary)])
                (evidence / "build.stdout").write_bytes(result.stdout)
                (evidence / "build.stderr").write_bytes(result.stderr)
                assert result.returncode == 0, "explicit build failed: " + result.stderr.decode()[:400]
                record = json.loads(result.stdout)
                assert record["sourceSha256"] == digest(c_source)
                assert record["outputSha256"] == digest(binary)
                assert record["target"] == {"x86_64": "x64", "aarch64": "arm64"}[platform.machine()]
                assert record["mode"] == "static" and record["source"] == str(c_source)
                assert record["output"] == str(binary)
                assert record["compiler"] and record["compilerVersion"]
                assert (binary.stat().st_mode & 0o777) == 0o755
                results["artifact"] = elf(binary)
                results["build"] = record
                return record

            check("actual_explicit_build_static_ELF_target_and_record", build)

            def no_output():
                result = run([str(node), str(builder)])
                assert result.returncode != 0, "missing output unexpectedly built"
            check("build_requires_explicit_output", no_output)

            def failed_compile():
                prior = binary.read_bytes()
                env = dict(os.environ, CC="/bin/false")
                result = run([str(node), str(builder), str(binary)], env=env)
                assert result.returncode != 0 and binary.read_bytes() == prior
                assert sorted(p.name for p in generation.iterdir()) == [
                    "matrix-terminal-attachment-entry", "node", "terminal-io-attach.mjs"]
            if binary.exists():
                check("failed_compile_preserves_output_and_cleans_temporary", failed_compile)

            def dynamic_rejection():
                prior = binary.read_bytes()
                dynamic_output = root / "compiler-produced-dynamic-ELF"
                shim = root / "dynamic-compiler.py"
                real_compiler = shutil.which(os.environ.get("CC", "cc"))
                assert real_compiler, "existing compiler required"
                shim.write_text("#!" + sys.executable + "\n" +
                                "import pathlib, shutil, subprocess, sys\n" +
                                "args = [arg for arg in sys.argv[1:] if arg != '-static']\n" +
                                "result = subprocess.run([" + repr(real_compiler) + ", *args], timeout=30)\n" +
                                "if result.returncode == 0 and '-o' in args:\n" +
                                "    shutil.copyfile(args[args.index('-o') + 1], " + repr(str(dynamic_output)) + ")\n" +
                                "sys.exit(result.returncode)\n")
                shim.chmod(0o700)
                result = run([str(node), str(builder), str(binary)], env=dict(os.environ, CC=str(shim)))
                assert dynamic_output.is_file(), "shim did not compile actual C"
                try:
                    elf(dynamic_output)
                except AssertionError as error:
                    assert str(error) in ("PT_INTERP forbidden", "DT_NEEDED forbidden"), str(error)
                else:
                    raise AssertionError("fixture compiler unexpectedly produced static ELF")
                assert result.returncode != 0, "build accepted compiler-produced dynamic ELF"
                assert binary.read_bytes() == prior, "rejection replaced existing output"
                assert sorted(p.name for p in generation.iterdir()) == [
                    "matrix-terminal-attachment-entry", "node", "terminal-io-attach.mjs"]
                return {"actual_dynamic_sha256": digest(dynamic_output), "output_preserved": True,
                        "temporary_cleaned": True}
            if binary.exists():
                check("compiler_produced_dynamic_ELF_rejected_without_replacing_output", dynamic_rejection)

            if binary.exists() and not results["failures"]:
                marker = root / "markers"
                hook = root / "hook.cjs"
                hook.write_text("require('node:fs').appendFileSync(" + json.dumps(str(marker)) + ", 'node\\n')")
                marker_c = root / "marker.c"
                marker_c.write_text('''#include <stdio.h>
__attribute__((constructor)) static void mark(void) { FILE *f = fopen(MARKER, "a"); if (f) { fputs("loader\\n", f); fclose(f); } }
unsigned int la_version(unsigned int version) { (void)version; return 2; }
''')
                library = root / "marker.so"
                result = run([os.environ.get("CC", "cc"), "-shared", "-fPIC", "-Wall", "-Wextra", "-Werror",
                              '-DMARKER="' + str(marker) + '"', str(marker_c), "-o", str(library)])
                assert result.returncode == 0, result.stderr.decode()
                (home / ".profile").write_text("printf profile >> " + str(marker) + "\n")
                env = {"PATH": str(root), "LANG": "poison", "HOME": str(home),
                       "NODE_OPTIONS": "--require=" + str(hook), "LD_PRELOAD": str(library),
                       "LD_AUDIT": str(library), "BUN_OPTIONS": "owner-setting",
                       "OWNER_SENTINEL": "fixture-secret-never-print"}
                retained = root / "retained-owner-fd"
                retained.write_text("private fixture descriptor")
                low = os.open(retained, os.O_RDONLY)
                high = fcntl.fcntl(low, fcntl.F_DUPFD, 2048)

                def launch(args, preexec=None, argv0=None):
                    return run([argv0 or str(binary), *args], executable=str(binary),
                               env=env, cwd=cwd, input=b"stdio-input\n", pass_fds=(low, high),
                               preexec_fn=preexec)

                def valid(preexec=None, argv0=None):
                    result = launch([public_io], preexec, argv0)
                    assert result.returncode == 7, (result.returncode, result.stderr.decode()[:300])
                    record = json.loads(result.stdout)
                    assert record["argv"] == [str(generation / "node"), str(js), public_io]
                    assert record["env"] == {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}
                    assert record["cwd"] == str(cwd) and record["input"] == "stdio-input\n"
                    assert result.stderr == b"fixture-stderr\n"
                    assert str(retained) not in record["links"], record["links"]
                    assert not marker.exists(), "startup hook/profile executed"
                    return {"exit": result.returncode, "cwd_stdio": True,
                            "exact_argv_env": True, "retained_fd_targets_absent": True}

                try:
                    check("direct_exec_exact_env_argv_cwd_stdio_exit_and_FD_cleanup", valid)
                    check("argv0_spoof_cannot_choose_generation", lambda: valid(argv0="/not-generation/entry"))
                    check("kernel_inventory_fallback_closes_high_FDs", lambda: valid(lambda: deny_syscalls([436])))

                    def rejected(args, preexec=None):
                        result = launch(args, preexec)
                        assert result.returncode != 0, "invalid input accepted"
                        assert not result.stdout, "invalid input entered Node"
                        assert len(result.stderr) <= 80 and result.stderr in (b"", b"Terminal I/O unavailable\n"), result.stderr
                        assert not marker.exists(), "startup hook executed"

                    cases = {"missing": [], "extra": [public_io, "secret-extra"], "relative": [public_io[1:]],
                             "traversal": ["/tmp/../tmp" + public_io[4:]], "dot": ["/tmp/." + public_io[4:]],
                             "double_slash": ["/tmp/" + public_io[4:]], "query": [public_io + "?secret"],
                             "fragment": [public_io + "#secret"], "space": ["/tmp/x " + public_io[4:]],
                             "control": ["/tmp/x\x7f" + public_io[4:]], "newline": [public_io + "\n"],
                             "uppercase": [public_io.replace("abcdef", "ABCDEF")],
                             "wrong_socket": [public_io.replace("io.sock", "control.sock")],
                             "too_long": ["/" + "a" * 70 + public_io]}
                    for name, args in cases.items():
                        check("reject_" + name + "_without_Node_or_disclosure", lambda args=args: rejected(args))

                    def closure_failure():
                        openat = 257 if platform.machine() == "x86_64" else 56
                        rejected([public_io], lambda: deny_syscalls([436, openat]))
                    check("FD_closure_unavailable_fails_closed", closure_failure)

                    for sibling in ("node", "terminal-io-attach.mjs"):
                        def missing(sibling=sibling):
                            path = generation / sibling
                            saved = path.with_suffix(path.suffix + ".saved")
                            path.rename(saved)
                            try:
                                rejected([public_io])
                            finally:
                                saved.rename(path)
                        check("missing_" + sibling + "_coarse_failure", missing)

                    def exec_failure():
                        node_path = generation / "node"
                        saved = root / "saved-node"
                        node_path.rename(saved)
                        node_path.write_text("not an executable image; fixture-secret")
                        node_path.chmod(0o755)
                        try:
                            rejected([public_io])
                        finally:
                            node_path.unlink()
                            saved.rename(node_path)
                    check("exec_failure_has_no_shell_fallback_or_raw_error", exec_failure)

                    def signal_forwarding():
                        original = js.read_text()
                        js.write_text("process.stdout.write('ready\\n'); setInterval(() => {}, 1000);")
                        child = subprocess.Popen([str(binary), public_io], env=env, cwd=cwd,
                                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                                 start_new_session=True)
                        try:
                            import select
                            assert select.select([child.stdout], [], [], 5)[0], "Node readiness deadline"
                            assert os.read(child.stdout.fileno(), 6) == b"ready\n"
                            child.send_signal(signal.SIGTERM)
                            child.communicate(timeout=5)
                            assert child.returncode == -signal.SIGTERM
                        finally:
                            if child.poll() is None:
                                os.killpg(child.pid, signal.SIGKILL)
                                child.communicate(timeout=5)
                            js.write_text(original)
                    check("direct_exec_preserves_signal_termination", signal_forwarding)
                finally:
                    os.close(high)
                    os.close(low)
            if "artifact" in results:
                # Parent owns disposition/publication. Preserve exactly the bytes
                # exercised above, outside the temporary generation cleanup.
                assert digest(binary) == results["artifact"]["sha256"]
                retained_artifact = evidence / "matrix-terminal-attachment-entry"
                shutil.copy2(binary, retained_artifact)
                (evidence / "build-record.json").write_text(json.dumps(results["build"], indent=2) + "\n")
                results["retained_artifact"] = str(retained_artifact)
    results["temporary_assets_cleaned"] = True
    (evidence / "result.json").write_text(json.dumps(results, indent=2) + "\n")
    print(json.dumps(results, indent=2))
    return bool(results["failures"])


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({"fatal": type(error).__name__, "error": str(error)}))
        sys.exit(1)
