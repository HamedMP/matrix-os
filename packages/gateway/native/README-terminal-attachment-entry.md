# Fixed Terminal I/O attachment entry

Build explicitly on Linux x64 or arm64 with an existing C compiler and static
libc inputs. No dependencies are installed and there is no dynamic fallback:

```sh
node packages/gateway/native/build-terminal-attachment-entry.mjs /absolute/existing-directory/matrix-terminal-attachment-entry
```

`CC` selects the compiler executable (default `cc`). Compilation uses C11,
optimization, warnings as errors and `-static`, with a 30-second deadline.
The compiler version probe has a five-second deadline. Each invocation runs in
an owned Linux process group, uses SIGKILL on deadline, kills remaining group
members even after the compiler leader exits, and awaits direct-child reaping.
Pipe/reaping cleanup has a separate one-second bound; an exceptional unknown
cleanup outcome fails the build instead of being reported as success.
The script checks the actual ELF architecture, interpreter and dependency
tables before atomically replacing the explicit output. It prints JSON source,
compiler, target, hash and static-mode evidence. Failed builds preserve an
existing output and remove their exclusive temporary directory.

The executable accepts exactly one public I/O socket reference, with the same
canonical absolute path shape and byte bound as `terminalIoLocation`, rejecting
control characters. It derives its directory from `/proc/self/exe` and directly
executes only sibling `node terminal-io-attach.mjs <ioReference>`. It preserves
cwd and standard descriptors, removes all other inherited descriptors, and
supplies only `PATH=/usr/bin:/bin` and `LANG=C.UTF-8`. Descriptor closure uses
Linux `close_range`, with a bounded `/proc/self/fd` inventory fallback; inability
to guarantee closure fails closed. Invalid input, unavailable siblings and
exec errors produce only a coarse error. No shell or profile is run.

This cleans the internal attachment helper only. Native work keeps its existing
environment through its separate launch path. The public I/O reference confers
no source or stop authority, and attachment exit does not imply native exit.
The existing JavaScript entry remains responsible for generation validation.
This component does not alter generation manifests, bounds, legacy behavior,
installation, Zellij routing or source admission. Future routing remains
unavailable wherever the helper has not been separately packaged and verified.

Run the standalone Linux component fixture explicitly:

```sh
python3 tests/terminal-runtime/native-attachment-entry-fixture.py /absolute/source-root /tmp/new-evidence-directory
```

It builds and executes this actual C artifact with real Node and a recording
JavaScript fixture. That JavaScript is component-only evidence, not acceptance
of the production generation closure or a native harness. Required prerequisites
fail instead of being skipped. Temporary test assets and owned children are
cleaned up; bounded raw JSON evidence remains in the supplied new directory.
The fixture becomes a process-local Linux child subreaper for its controlled
orphan tests. It kills owned groups independently of leader state and bounds
direct/adopted-child reaping. Regression cases cover TERM-resistant compilers,
descendants holding output pipes, and leader-first exit with held/closed pipes.
