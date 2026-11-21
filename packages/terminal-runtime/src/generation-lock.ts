import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
/** Reuses the installed GC helper's flock. Call only after validating/creating the
 * private descriptor directory; nothing in this helper supervises workloads. */
export async function withTerminalGenerationLock<T>(options: {
  helperPath: string; descriptorRoot: string; cwd: string; env: NodeJS.ProcessEnv;
}, operation: () => Promise<T>): Promise<T> {
  if (![options.helperPath, options.descriptorRoot, options.cwd].every(isAbsolute)) throw new Error("Terminal generation lock unavailable");
  const child = spawn("python3", [options.helperPath, "--lock", options.descriptorRoot], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
  let lost = false, exited = false, output = "", errorBytes = 0;
  const exit = new Promise<void>(resolve => { child.once("exit", () => { exited = true; lost = true; resolve(); }); child.once("error", () => { exited = true; lost = true; resolve(); }); });
  child.stderr.on("data", (bytes: Buffer) => { errorBytes += bytes.length; if (errorBytes > 4096) child.kill("SIGKILL"); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Terminal generation lock unavailable")); }, 15000);
      const fail = () => { clearTimeout(timer); reject(new Error("Terminal generation lock unavailable")); };
      child.once("error", fail); child.once("exit", fail);
      child.stdout.on("data", (bytes: Buffer) => {
        output += bytes.toString("utf8");
        if (Buffer.byteLength(output) > 16) { child.kill("SIGKILL"); fail(); return; }
        if (output === "locked\n") { clearTimeout(timer); child.off("error", fail); child.off("exit", fail); resolve(); }
      });
    });
    if (lost) throw new Error("Terminal generation lock unavailable");
    const result = await operation();
    if (lost) throw new Error("Terminal generation lock lost");
    return result;
  } finally {
    child.stdin.on("error", error => { if (!("code" in error) || error.code !== "EPIPE") console.warn("[terminal-generation] Lock release unavailable", error.name); });
    child.stdin.end();
    if (!exited) {
      let timer: NodeJS.Timeout | undefined;
      try { await Promise.race([exit, new Promise<void>(resolve => { timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 1000); })]); }
      finally { clearTimeout(timer); }
    }
  }
}
