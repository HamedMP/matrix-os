import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
/** Run only fixed reviewed tools. Never echo opaque/candidate/provider output
 * into GitHub workflow command parsing, and never interpolate it into a shell. */
export async function runPreviewTool(file: string, args: string[], env: NodeJS.ProcessEnv, input?: string, timeout = 15 * 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: fileURLToPath(new URL("../../", import.meta.url)), env,
      stdio: ["pipe", "pipe", "pipe"], signal: AbortSignal.timeout(timeout), shell: false });
    let length = 0, outputLength = 0; const collected = Buffer.alloc(2 * 1024 * 1024);
    const capture = (chunk: Buffer, output: boolean) => {
      length += chunk.length;
      if (length > 2 * 1024 * 1024) { child.kill(); reject(new Error("Preview tool output is unavailable")); }
      else if (output) { chunk.copy(collected, outputLength); outputLength += chunk.length; }
    };
    child.stdout.on("data", chunk => capture(chunk, true)); child.stderr.on("data", chunk => capture(chunk, false));
    child.once("error", () => reject(new Error("Preview tool is unavailable")));
    child.stdin.once("error", () => reject(new Error("Preview tool input is unavailable")));
    child.once("close", code => code === 0 ? resolve(collected.subarray(0, outputLength).toString("utf8")) : reject(new Error("Preview tool is unavailable")));
    child.stdin.end(input);
  });
}
