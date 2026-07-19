import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const VERSION_PATTERN = /^(?:codex(?:-cli)?\s+)?v?(\d+\.\d+\.\d+)(?:\s.*)?$/;
const VERSION_TIMEOUT_MS = 5_000;

export async function assertCodexProviderVersion({ command, expectedVersion, cwd }) {
  if (!/^\d+\.\d+\.\d+$/.test(expectedVersion)) {
    throw new Error("Codex provider version is not verified");
  }
  try {
    const result = await execFileAsync(command, ["--version"], {
      cwd,
      timeout: VERSION_TIMEOUT_MS,
      signal: AbortSignal.timeout(VERSION_TIMEOUT_MS),
      encoding: "utf8",
      maxBuffer: 64 * 1024,
    });
    const versionLine = `${result.stdout}\n${result.stderr}`
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
    const actualVersion = versionLine?.match(VERSION_PATTERN)?.[1];
    if (actualVersion !== expectedVersion) {
      throw new Error("version_mismatch");
    }
  } catch (_error) {
    throw new Error("Codex provider version is not verified");
  }
}
