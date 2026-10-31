import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { verifyJevHermesRuntimePin } from "./jev-hermes-runtime-pin.js";

/** Compose with the owned browser/restricted bootstrap, never replace its setup or borrow its credentials. */
export async function hermesRoutineBootstrap(root: string, args: string[], signal: AbortSignal): Promise<string[] | undefined> {
  try {
    await verifyJevHermesRuntimePin(root, signal);
    const path = new URL("./hermes-routine-tool.py", import.meta.url);
    const resourcePath = fileURLToPath(path);
    const bytes = await readFile(path);
    if (bytes.byteLength > 32768) throw new Error("Routine resource unavailable");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const entry = "runpy.run_module('tui_gateway.entry', run_name='__main__')";
    let prefix: string[], setup: string;
    if (args.join("\0") === "-u\0-m\0tui_gateway.entry") {
      prefix = ["-u", "-c"]; setup = `import sys, runpy\nsys.path.insert(0, ${JSON.stringify(root)})\n`;
    } else if (args.at(-2) === "-c" && args.at(-1)!.endsWith(entry)) {
      prefix = args.slice(0, -1); setup = args.at(-1)!.slice(0, -entry.length);
    } else throw new Error("Routine bootstrap unavailable");
    return ["-B", "-X", "pycache_prefix=/dev/null/matrix-routine-cache", ...prefix, setup + [
      "import hashlib, sys",
      "matrix_routine = None",
      "try:",
      `    with open(${JSON.stringify(resourcePath)}, 'rb') as matrix_resource_file: matrix_resource = matrix_resource_file.read(32769)`,
      `    if hashlib.sha256(matrix_resource).hexdigest() != ${JSON.stringify(hash)}: raise RuntimeError('Routine resource unavailable')`,
      `    matrix_namespace = {'__name__':'matrix_routine_owned', '__file__':${JSON.stringify(resourcePath)}}`,
      `    exec(compile(matrix_resource, ${JSON.stringify(resourcePath)}, 'exec'), matrix_namespace)`,
      "    matrix_routine = matrix_namespace['install']()",
      "except Exception as matrix_routine_error:",
      "    print('[matrix-routines] Resource unavailable: ' + type(matrix_routine_error).__name__, file=sys.stderr)",
      "try:", `    ${entry}`, "finally:", "    if matrix_routine is not None: matrix_routine.dispose()",
    ].join("\n")];
  } catch (error) {
    console.warn("[hermes-routines] Runtime unavailable", error instanceof Error ? error.name : "UnknownError");
    return undefined; // Ordinary Hermes retains its existing launch when optional support cannot be qualified.
  }
}
