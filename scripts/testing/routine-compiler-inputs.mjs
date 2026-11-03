/** Actual local compiler source/config inputs; no emit or external calls. */
import ts from "typescript";
import { readFile, realpath } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import { createHash } from "node:crypto";
export async function collectRoutineCompilerInputs(root) {
  root = await realpath(root);
  const files = new Set(); // One bounded build snapshot; discarded on return.
  const add = file => {
    const path = resolve(file);
    if (path.startsWith(`${root}/`) && !/\/(node_modules|dist)\//.test(path)) files.add(path);
    if (files.size > 10000) throw new Error("Compiler input inventory exceeds bounds");
  };
  const readConfig = file => { add(file); return ts.sys.readFile(file); };
  for (const name of ["observability", "kernel"]) {
    const configFile = resolve(root, "packages", name, "tsconfig.json");
    const config = ts.readConfigFile(configFile, readConfig);
    if (config.error) throw new Error("Compiler input configuration unavailable");
    const parsed = ts.parseJsonConfigFileContent(config.config, { ...ts.sys, readFile: readConfig }, dirname(configFile), {}, configFile);
    if (parsed.errors.length || !parsed.fileNames.length) throw new Error("Compiler input configuration invalid");
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    for (const source of program.getSourceFiles()) add(source.fileName);
  }
  const inputs = []; let bytes = 0;
  for (const file of [...files].sort()) {
    const actual = await realpath(file), content = await readFile(file);
    if (!actual.startsWith(`${root}/`) || (bytes += content.length) > 128 * 1024 * 1024) throw new Error("Compiler source identity/budget invalid");
    inputs.push({ path: relative(root, file), realPath: actual, sha256: createHash("sha256").update(content).digest("hex") });
  }
  if (!inputs.length) throw new Error("Empty compiler input inventory");
  return inputs;
}
