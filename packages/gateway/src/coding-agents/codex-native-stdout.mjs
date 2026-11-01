import { spawn as spawnChild } from "node:child_process";
import { consumeCodexProviderOutput } from "./codex-provider-output.mjs";

const POLL_MS = 4;
class FencedOutput extends Error {}

/** Internal transport only. No owner, artifact, policy or routine authority.
 * The injected builder is trusted to select native command/argv/env/cwd.
 * PIDFD/SCM credentials cannot establish lifetime executable continuity.
 * Never wire this into ordinary startup until the remaining gates are proved. */
export function createCodexNativeStdout({ native, command, args, cwd, env, spawn = spawnChild }) {
  const pair = native.stdoutPair();
  let child;
  try {
    // Numeric fd is used solely here; Node duplicates it to the child's fd1.
    child = spawn(command, args, { cwd, env, stdio: ["pipe", native.stdoutWriterFd(pair.writer), "pipe"], shell: false });
  } catch (error) {
    native.close(pair.receiver);
    throw error;
  } finally {
    native.close(pair.writer);
  }

  let birth, fenced = false, generation = 0, readerClosed = false, consuming = false;
  let timer, wake, drainStarted = false;
  let finishExit;
  const exited = new Promise(resolve => { finishExit = resolve; });
  function fence() { if (!fenced) { fenced = true; generation++; } interruptWait(); }
  function interruptWait() {
    clearTimeout(timer); timer = undefined;
    const resume = wake; wake = undefined; resume?.();
  }
  function wait() {
    return new Promise(resolve => {
      wake = resolve;
      timer = setTimeout(() => { timer = undefined; wake = undefined; resolve(); }, POLL_MS);
      timer.unref();
    });
  }
  function closeBirth() { if (birth) { native.close(birth); birth = undefined; } }
  function closeReader() {
    fence();
    if (!readerClosed) { readerClosed = true; native.close(pair.receiver); }
    interruptWait();
  }
  function current(expected = generation) {
    if (fenced || readerClosed || expected !== generation || !birth) return false;
    try {
      if (native.childAlive(birth)) return true;
    } catch (_error) { /* Unsupported/dead observations cannot restore authority. */ }
    fence(); return false;
  }
  // No caller-nominated PID. Capture the actual direct child's pidfd in this
  // synchronous turn, before Node can reap it and reuse its numeric PID.
  try { if (child.pid) birth = native.retainChild(child.pid); } catch (_error) { fence(); }
  if (!birth) fence();
  child.once("exit", (code, signal) => {
    fence(); closeBirth(); finishExit({ code, signal });
  });
  child.on("error", () => {
    fence();
    // An error on an already-spawned child does not prove native exit.
    if (!child.pid) { closeBirth(); finishExit({ code: null, signal: null, spawnFailed: true }); }
  });

  function receive(onBytes) {
    const packet = native.stdoutReceive(pair.receiver);
    if (packet === false) { closeReader(); return false; }
    if (packet) onBytes?.(packet.data); // Explicitly nonauthoritative ordinary I/O.
    return packet;
  }
  // After proof loss only the byte sink remains. One recvmsg per tick, no
  // accumulated event/byte queue and no retry, source revival or child signal.
  function drain(onBytes) {
    if (drainStarted || readerClosed) return;
    drainStarted = true;
    void (async () => {
      try {
        while (!readerClosed) { receive(onBytes); if (!readerClosed) await wait(); }
      } catch (_error) { closeReader(); }
    })();
  }
  function consume({ onMessage, onBytes }) {
    if (consuming) throw new Error("Native stdout already consumed");
    consuming = true;
    async function* chunks() {
      let reads = 0;
      while (!readerClosed) {
        if (!current()) throw new FencedOutput();
        let packet;
        try { packet = receive(onBytes); } catch (error) { closeReader(); throw error; }
        if (packet === false) throw new FencedOutput();
        if (packet) {
          const writer = packet.writer;
          if (!writer || writer.pid !== child.pid || writer.uid !== pair.uid || writer.gid !== pair.gid || !current()) {
            fence(); throw new FencedOutput();
          }
          yield packet.data;
        }
        if (!readerClosed && (!packet || ++reads >= 16)) { reads = 0; await wait(); }
      }
      throw new FencedOutput(); // Never dispatch a partial frame on reader loss.
    }
    const expected = generation;
    return consumeCodexProviderOutput(chunks(), async message => {
      // A queued callback must recheck this same guard at its actual action
      // boundary. It establishes only this transport generation, never source.
      const isCurrent = () => current(expected);
      if (isCurrent()) await onMessage(message, isCurrent);
    }).catch(error => {
      fence();
      if (!(error instanceof FencedOutput)) throw error;
    }).finally(() => { drain(onBytes); });
  }
  return { child, exited, consume, fence, closeReader, isFenced: () => fenced };
}
