import { spawn, type ChildProcess } from "node:child_process";
import type { PreviewPairLaunchAttestation } from "../../packages/contracts/src/preview-pair-launch.js";
import { previewDesktopReady } from "./desktop-ready.js";
/** Deliberate OS/display essentials only; never copy a credential, Node preload,
 * dev renderer URL, Root gateway override or cloud/provider environment. */
export function previewDesktopEnvironment(proof: PreviewPairLaunchAttestation, userData: string, port: string, env = process.env) {
  const selected: NodeJS.ProcessEnv = {};
  for (const name of ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "TMPDIR", "SYSTEMROOT"]) {
    if (env[name]) selected[name] = env[name];
  }
  return { ...selected, OPERATOR_USER_DATA_DIR: userData, MATRIX_PREVIEW_PAIR_CONTEXT: JSON.stringify(proof), MATRIX_PREVIEW_PAIR_READY_PORT: port };
}
export async function stopOwnedPreviewChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  child.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([closed, new Promise<void>(resolve => { timer = setTimeout(resolve, 5_000); })]);
  if (timer) clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}
export async function startPreviewDesktop(options: { executable: string; proof: PreviewPairLaunchAttestation; userData: string; timeoutMs?: number; signal?: AbortSignal }) {
  options.signal?.throwIfAborted();
  const signal = await previewDesktopReady(options.proof.context, options.timeoutMs);
  let child: ChildProcess | undefined, cancel: (() => void) | undefined;
  let reused = false;
  try {
    options.signal?.throwIfAborted();
    const started = spawn(options.executable, [], { env: previewDesktopEnvironment(options.proof, options.userData, signal.port),
      stdio: "ignore", shell: false });
    child = started;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new Error("Preview desktop startup cancelled"));
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) cancel();
    });
    const died = new Promise<never>((_resolve, reject) => {
      started.once("error", () => reject(new Error("Preview desktop could not start")));
      started.once("exit", (code, sig) => { if (code !== 0 || sig) reject(new Error("Preview desktop stopped before startup")); });
    });
    const pid = await Promise.race([signal.ready, died, cancelled]);
    reused = pid !== started.pid;
    return { role: options.proof.context.role, pid, reused, child: started,
      closed: started.exitCode !== null || started.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => started.once("close", () => resolve())),
      async stop() { if (!reused) await stopOwnedPreviewChild(started); } };
  } catch (error: unknown) { if (child) await stopOwnedPreviewChild(child); throw error; }
  finally {
    if (cancel) options.signal?.removeEventListener("abort", cancel);
    await signal.dispose();
  }
}
