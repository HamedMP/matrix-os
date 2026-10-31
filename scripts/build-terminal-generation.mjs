// Offline, unprivileged packaging only. No installs, downloads or service changes.
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { builtinModules } from "node:module";
import { createTerminalClosureManifest, terminalClosureGeneration, validateTerminalClosure } from "../packages/terminal-runtime/src/generation-closure.mjs";
const exec = promisify(execFile), rootDefault = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entries = { "terminal-host": "packages/gateway/src/terminal/host-entry.ts", "terminal-service": "packages/gateway/src/terminal/service-entry.ts",
  "terminal-io-attach": "packages/gateway/src/terminal/io-attach-entry.ts", "terminal-protocol": "packages/gateway/src/coding-agents/terminal-launch-protocol.mjs" };
export async function bundleTerminalHostAssets(root, output) {
  // Reuse the existing pinned build dependency without relying on root hoisting.
  const buildRequire = createRequire(join(root, "packages/scope-runtime/package.json"));
  const { build } = await import(pathToFileURL(buildRequire.resolve("esbuild")).href);
  const result = await build({ absWorkingDir: root, entryPoints: entries, bundle: true, platform: "node", format: "esm", target: "node24", conditions: ["development"], outdir: output,
    outExtension: { ".js": ".mjs" }, sourcemap: false, metafile: true, logLevel: "silent" });
  const outputs = Object.values(result.metafile.outputs);
  for (const file of outputs) for (const entry of file.imports) {
    if (!entry.external || !(entry.path.startsWith("node:") || builtinModules.includes(entry.path))) throw new Error("Persistent Terminal has an external package dependency");
  }
  for (const name of Object.keys(entries)) await chmod(join(output, name + ".mjs"), 0o644);
  await copyRegular(join(root, "packages/terminal-runtime/src/generation-closure.mjs"), join(output, "generation-closure.mjs"));
  return { inputs: Object.keys(result.metafile.inputs).sort(), outputs };
}
async function copyRegular(source, target, executable = false) {
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024 * 1024) throw new Error("Terminal build asset unavailable");
  await mkdir(dirname(target), { recursive: true, mode: 0o755 }); await copyFile(source, target); await chmod(target, executable ? 0o755 : 0o644);
}
async function copyTree(source, target, filter = () => true) {
  let count = 0;
  async function copy(directory, relative) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Terminal dependency unavailable");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!filter(entry.name) || ["node_modules", ".git", ".github"].includes(entry.name)) continue;
      if (++count > 400 || entry.isSymbolicLink()) throw new Error("Terminal dependency closure unavailable");
      const name = relative ? relative + "/" + entry.name : entry.name;
      if (entry.isDirectory()) await copy(join(directory, entry.name), name);
      else if (entry.isFile()) await copyRegular(join(directory, entry.name), join(target, name));
      else throw new Error("Terminal dependency closure unavailable");
    }
  }
  await copy(source, "");
}
export async function stageTerminalGeneration(options) {
  const root = resolve(options.root ?? rootDefault), outputRoot = resolve(options.outputRoot);
  const require = createRequire(join(root, "packages/gateway/package.json"));
  const nodePtyRoot = await realpath(options.nodePtyRoot ?? dirname(require.resolve("node-pty/package.json")));
  const addonRequire = createRequire(join(nodePtyRoot, "package.json"));
  const nodeAddonApiRoot = await realpath(options.nodeAddonApiRoot ?? dirname(addonRequire.resolve("node-addon-api/package.json")));
  const ptyPackage = JSON.parse(await readFile(join(nodePtyRoot, "package.json"), "utf8"));
  const addonPackage = JSON.parse(await readFile(join(nodeAddonApiRoot, "package.json"), "utf8"));
  if (ptyPackage.name !== "node-pty" || ptyPackage.version !== "1.1.0" || addonPackage.name !== "node-addon-api" || !/^7\.1\.[0-9]+$/.test(addonPackage.version)) throw new Error("Terminal native dependency version mismatch");
  await mkdir(join(outputRoot, "generations"), { recursive: true, mode: 0o755 });
  const temporary = await mkdtemp(join(outputRoot, "generations", ".incoming-"));
  try {
    if (options.assetsDirectory) {
      for (const name of [...Object.keys(entries).map(name => name + ".mjs"), "generation-closure.mjs"]) await copyRegular(join(options.assetsDirectory, name), join(temporary, name));
    } else await bundleTerminalHostAssets(root, temporary);
    for (const [source, name, executable] of [
      [options.nodePath, "node", true], [options.zellijPath, "zellij", true],
      [join(root, "distro/customer-vps/host-bin/matrix-terminal-user-keeper.mjs"), "matrix-terminal-user-keeper.mjs", true],
      [join(root, "distro/customer-vps/host-bin/matrix-terminal-attach.mjs"), "matrix-terminal-attach.mjs", true],
      [options.writerPath ?? join(root, "packages/gateway/dist/terminal/terminal-writer.node"), "terminal-writer.node", false],
    ]) await copyRegular(source, join(temporary, name), executable);
    const ptyOutput = join(temporary, "node_modules/node-pty");
    await copyRegular(join(nodePtyRoot, "package.json"), join(ptyOutput, "package.json"));
    await copyTree(join(nodePtyRoot, "lib"), join(ptyOutput, "lib"), name => !/\.test\./.test(name));
    // Canonical Linux loader prefers build/Release. Copy exactly one binary, never a mutable search-path fallback.
    let ptyNative = options.ptyNativePath;
    if (!ptyNative) {
      const candidate = join(nodePtyRoot, "build/Release/pty.node");
      try { await lstat(candidate); ptyNative = candidate; }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; ptyNative = join(nodePtyRoot, `prebuilds/${process.platform}-${process.arch}/pty.node`); }
    }
    await copyRegular(ptyNative, join(ptyOutput, "build/Release/pty.node"));
    await copyTree(nodeAddonApiRoot, join(temporary, "node_modules/node-addon-api"), name => !["test", "tests", "doc"].includes(name));
    // Actual pinned executable loads both actual native addons before any generation is published.
    const script = `const path=require('node:path');const root=process.argv[1];require(path.join(root,'node_modules/node-pty/lib/index.js'));const writer=require(path.join(root,'terminal-writer.node'));for(const key of ['listen','accept','receive','send','close'])if(typeof writer[key]!=='function')throw Error('native writer unavailable');const libc=process.report.getReport().header.glibcVersionRuntime;console.log(JSON.stringify({version:process.versions.node,modules:process.versions.modules,napi:process.versions.napi,platform:process.platform,arch:process.arch,libc:libc?'glibc:'+libc:'musl'}));`;
    const { stdout } = await exec(join(temporary, "node"), ["-e", script, temporary], { timeout: 15000, maxBuffer: 16384,
      env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME } });
    const runtime = { ...JSON.parse(stdout), nodePty: ptyPackage.version, nodeAddonApi: addonPackage.version, writerNapi: 8, protocol: 1 };
    const manifest = await createTerminalClosureManifest(temporary, runtime), generation = terminalClosureGeneration(manifest);
    await writeFile(join(temporary, "closure.json"), JSON.stringify(manifest) + "\n", { flag: "wx", mode: 0o644 });
    await writeFile(join(temporary, "GENERATION"), generation + "\n", { flag: "wx", mode: 0o644 });
    await validateTerminalClosure(temporary, generation, runtime);
    const destination = join(outputRoot, "generations", generation);
    try { await lstat(destination); await validateTerminalClosure(destination, generation, runtime); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; await rename(temporary, destination); }
    return { generation, directory: destination, manifest };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [nodePath, zellijPath, outputRoot, ...extra] = process.argv.slice(2);
  if (!nodePath || !zellijPath || !outputRoot || extra.length) throw new Error("Expected pinned Node, verified Zellij and output runtime directory");
  const result = await stageTerminalGeneration({ nodePath, zellijPath, outputRoot });
  process.stdout.write(result.generation + "\n");
}
