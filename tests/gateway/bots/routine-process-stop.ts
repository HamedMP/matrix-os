import type { ChildProcess } from "node:child_process";

/** Bounded shutdown shared by the real built-process qualification lane. */
export function createRoutineProcessStop(child: ChildProcess, ended: Promise<void>) {
  let deliberateCrash = false;
  function assertExit() {
    const { exitCode: code, signalCode: signal } = child;
    if ((code === 0 && signal === null && !deliberateCrash)
      || (code === null && signal === "SIGKILL" && deliberateCrash)) return;
    throw new Error(`Unexpected child exit: code=${code}, signal=${signal}`);
  }
  return async function stop(kill = false) {
    if (child.exitCode !== null || child.signalCode !== null) { assertExit(); return; }
    if (kill) deliberateCrash = child.kill("SIGKILL");
    else child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped: boolean;
    try {
      stopped = await Promise.race([ended.then(() => true), new Promise<boolean>(done => {
        timer = setTimeout(() => done(false), 12000);
      })]);
    } finally { clearTimeout(timer); }
    if (stopped!) {
      console.info("routine_process_exit", { pid: child.pid, code: child.exitCode, signal: child.signalCode });
      assertExit(); return;
    }
    child.kill("SIGKILL");
    try {
      await Promise.race([ended, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Child exit uncertain after SIGKILL")), 5000);
      })]);
    } finally { clearTimeout(timer); }
    throw new Error("Graceful child stop timed out; SIGKILL exit was confirmed");
  };
}
