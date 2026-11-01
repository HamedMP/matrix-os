import { constants } from "node:fs";
import { access, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export async function goldenHostSystemCommand(command: string): Promise<string> {
  for (const directory of ["/usr/bin", "/bin"]) {
    const candidate = join(directory, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  throw new Error(`Fixture requires ${command}`);
}

/** Keep Ubuntu host scripts unchanged while running their fixtures on macOS. */
export async function createGoldenHostTestCommands(originalPath: string) {
  const trueBinary = await goldenHostSystemCommand("true");
  if (process.platform !== "darwin") {
    return { path: originalPath, trueBinary, copyPrerequisiteFixture: copyFile, cleanup: async () => {} };
  }
  const directory = await mkdtemp(join(tmpdir(), "matrix-golden-test-commands-"));
  try {
    // GNU stat without -L reports the link itself. Use real metadata rather
    // than fixed success values so permission/size/symlink guards stay tested.
    const program = join(directory, "stat.cjs");
    await writeFile(program, `const { lstatSync } = require("node:fs");
const [flag, format, file, extra] = process.argv.slice(2);
if (flag !== "-c" || !file || extra !== undefined) process.exit(1);
try {
  const value = lstatSync(file);
  const mode = (value.mode & 0o7777).toString(8);
  const formats = { "%a": mode, "%s": String(value.size), "%u": String(value.uid), "%u:%a": value.uid + ":" + mode };
  if (!Object.hasOwn(formats, format)) process.exit(1);
  process.stdout.write(formats[format] + "\\n");
} catch (error) { process.stderr.write(String(error) + "\\n"); process.exit(1); }
`, { mode: 0o644 });
    await writeFile(join(directory, "stat"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(program)} "$@"\n`, { mode: 0o755 });
    return {
      path: `${directory}:${originalPath}`,
      trueBinary,
      copyPrerequisiteFixture: async (source: string, target: string) => {
        // The Ubuntu script pins its system Python. Verify the development
        // interpreter's dependency only for fixtures that exercise that check.
        const { stdout } = await execFileAsync("python3", ["-I", "-c", "import cryptography, sys; print(sys.executable)"], { timeout: 10_000 });
        const python = stdout.trim();
        if (!isAbsolute(python)) throw new Error("Fixture requires an absolute Python interpreter");
        await access(python, constants.X_OK);
        // Keep the real GNU deadline and kill-after escalation in the copied
        // fixture; PATH alone cannot override Ubuntu's absolute timeout path.
        let timeout: string;
        try {
          const resolved = await execFileAsync("/bin/sh", ["-c", "command -v timeout || command -v gtimeout"], {
            env: { ...process.env, PATH: originalPath }, timeout: 10_000,
          });
          timeout = resolved.stdout.trim();
          if (!isAbsolute(timeout)) throw new Error("Expected an absolute timeout executable");
          await access(timeout, constants.X_OK);
          const version = await execFileAsync(timeout, ["--version"], { timeout: 10_000 });
          if (!/^timeout \(GNU coreutils\)/.test(version.stdout)) throw new Error("Expected GNU coreutils timeout");
        } catch (error) {
          throw new Error("Fixture requires an existing GNU timeout with --kill-after on PATH", { cause: error });
        }
        const script = await readFile(source, "utf8");
        await writeFile(target, script
          .replaceAll("/usr/bin/python3", shellQuote(python))
          .replaceAll("/usr/bin/timeout", shellQuote(timeout)), { mode: 0o755 });
      },
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
