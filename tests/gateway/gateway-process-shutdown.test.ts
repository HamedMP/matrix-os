import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

describe("real gateway entrypoint shutdown signal wiring", () => {
  it.each(["SIGINT", "SIGTERM", "both"] as const)("closes once and exits successfully for %s", async signal => {
    const root = await mkdtemp(join(tmpdir(), "gateway-signal-"));
    const source = await readFile("packages/gateway/src/main.ts", "utf8");
    const start = source.indexOf('// Graceful shutdown');
    const registration = source.slice(start >= 0 ? start : source.indexOf('process.on("SIGINT"'), source.indexOf('// Heap snapshot'));
    const usesHelper = registration.includes("registerGatewayShutdown");
    const script = `${usesHelper ? `import { registerGatewayShutdown } from ${JSON.stringify(pathToFileURL(resolve("packages/gateway/src/process-shutdown.ts")).href)};` : ""}
      const posthogProcessErrors = { dispose() { console.log('DISPOSE'); } };
      const gateway = { async close() { console.log('CLOSE_START'); await new Promise(resolve => setTimeout(resolve, 50)); console.log('CLOSE_DONE'); } };
      const processPosthogErrorTracker = { async shutdown() { console.log('TELEMETRY'); } };
      ${registration}
      setInterval(() => {}, 1000); console.log('READY');`;
    const file = join(root, "fixture.mjs"); await writeFile(file, script);
    const child = spawn(process.execPath, ["--import", pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href, file], {
      cwd: root, env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = ""; let first = false; let repeated = false;
    child.stdout.on("data", chunk => {
      output += chunk.toString();
      if (output.length > 4096) child.kill("SIGKILL");
      if (!first && output.includes("READY")) { first = true; child.kill(signal === "SIGTERM" ? "SIGTERM" : "SIGINT"); }
      if (signal === "both" && !repeated && output.includes("CLOSE_START")) { repeated = true; child.kill("SIGTERM"); child.kill("SIGINT"); }
    });
    let errors = ""; child.stderr.on("data", chunk => { errors += chunk.toString().slice(0, 4096 - errors.length); });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
    try {
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      expect(errors).toBe(""); expect(result).toEqual({ code: 0, signal: null });
      for (const marker of ["DISPOSE", "CLOSE_START", "CLOSE_DONE", "TELEMETRY"]) expect(output.split("\n").filter(line => line === marker)).toHaveLength(1);
    } finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await rm(root, { recursive: true, force: true }); }
  });
});
