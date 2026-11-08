# Internal credentialled native stdout

This Linux-only transport extends the existing `terminal-writer.node` addon. It does not enable routine source authority and is not wired into managed Codex startup. Other hosts fail closed for these observations while ordinary Terminal I/O keeps its existing path.

`createCodexNativeStdout({native, command, args, cwd, env})` allocates an anonymous credentialled stdout pair before synchronous direct spawn. The writer stays blocking; the producer closes its copy after spawn. Stdin, stderr and native argv/environment remain the caller's inputs. The returned direct ChildProcess and opaque pidfd establish only this transport's retained process lifetime.

- `consume({onMessage, onBytes?})` has one exclusive receiver and reuses the original 16MiB Codex JSON parser. `onBytes` is synchronous, bounded by the caller, and explicitly nonauthoritative. It receives a private byte copy.
- `onMessage(message, current)` must recheck `current()` at the actual action boundary. Credentials and currentness do not grant native-tool, owner, Computer, Chat, Bot, run or permission authority.
- Foreign/invalid ancillary data, native exit, reader loss and `fence()` permanently invalidate the generation and discard partial frames. Ordinary bytes continue draining while an already-started message callback is pending. Unexpected passed descriptors are closed. There is no retry or source revival.
- `closeReader()` cleans the receiver/timer. It never signals the child or means the native execution stopped. `exited` reports only the actual direct child's observed exit (or separately marked spawn failure). The caller owns child/stdin/stderr teardown.

Protected package/runtime/producer ancestors, namespace assumptions, lifetime executable continuity/no-self-replacement, actual native tool policy and canonical Chat/run joining are still required before any source admission. PIDFD and SCM credentials alone do not prove them. No owner/model grants are changed.

## Linux component validation

Run on Linux with Node 24, its N-API headers, and a C11 compiler. The runner requires a non-root user with empty effective, permitted and inheritable capabilities. It builds both addons and the C actor in a private temporary directory and removes it on exit. Run the same command as the required Native Stdout Linux CI job from the repository root:

```sh
timeout --kill-after=5s 120s bash scripts/ci/run-native-stdout-linux.sh
```

The command emits JSON cases, artifact hashes, platform/Node version and `sourceEnabled:false`, and exits nonzero on failure. The fault addon is test-only: it changes metadata returned after a real `recvmsg`; production never links it. The native actor exercises actual kernel credentials, same-FD foreign writes, descriptor delivery, process exit and EPIPE. The 253-rights case is real descriptor cleanup, not a claim of real kernel control-buffer truncation.

The recorded 34-case run used native Linux ARM64/Node24.21.0, network disabled, read-only root, UID501:GID20, no capabilities, no-new-privileges, 1536MiB, two CPUs, 192 PIDs and a 180-second outer limit. All compiles and cases passed, no OOM/outer timeout, container removed. A disposable removal of only the pidfd guard failed exactly its dedicated synchronous-exit assertion. No real account, model invocation, systemd install, shipped x64 or full repository CI acceptance follows from these results.
