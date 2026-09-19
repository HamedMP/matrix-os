import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { TerminalScrollLineSchema, TerminalScrollStateSchema, type TerminalScrollState } from "@matrix-os/contracts";

export const NATIVE_SCROLL_PLUGIN = fileURLToPath(new URL("../assets/scroll-v1.wasm", import.meta.url));

/** Append one OS plugin grant without replacing the owner's other grants. */
export async function prepareNativeScrollPlugin(homePath: string, env: Record<string, string>, pluginPath = NATIVE_SCROLL_PLUGIN): Promise<void> {
  const asset = await lstat(pluginPath);
  if (!asset.isFile() || asset.isSymbolicLink()) throw new Error("Native scroll plugin unavailable");
  const cache = process.platform === "darwin"
    ? join(homePath, "Library/Caches/org.Zellij-Contributors.Zellij")
    : join(env.XDG_CACHE_HOME ?? join(homePath, ".cache"), "zellij");
  // Refuse cache redirection outside the owner home and symlinked parents.
  const home = resolve(homePath);
  if (!resolve(cache).startsWith(`${home}/`)) throw new Error("Native scroll cache unavailable");
  let parent = home;
  for (const component of relative(home, cache).split("/")) {
    parent = join(parent, component);
    try { await mkdir(parent, { mode: 0o700 }); }
    catch (error: unknown) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }
    const stats = await lstat(parent);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("Native scroll cache unavailable");
  }
  const file = await open(join(cache, "permissions.kdl"), constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    if ((await file.stat()).size > 64 * 1024) throw new Error("Native scroll permissions exceed limit");
    const entry = `${JSON.stringify(pluginPath)} { ReadPaneContents; ReadCliPipes; ChangeApplicationState; }`;
    const contents = await file.readFile("utf8");
    if (!contents.includes(entry)) await file.write(`\n${entry}\n`);
  } finally { await file.close(); }
}

export async function queryNativeScroll(options: {
  sessionName: string; paneId: string; line?: number; pluginPath?: string;
  run(args: string[], timeoutMs: number): Promise<string>;
}): Promise<TerminalScrollState> {
  if (!/^(?:matrix-w-|matrix-rt_)[a-f0-9]{32}$/.test(options.sessionName) || !/^terminal_\d+$/.test(options.paneId)) {
    throw new Error("Invalid native terminal identity");
  }
  const payload = { pane: Number(options.paneId.slice(9)),
    ...(options.line === undefined ? {} : { line: TerminalScrollLineSchema.parse(options.line) }) };
  const output = await options.run(["--session", options.sessionName, "pipe", "--plugin",
    `file:${options.pluginPath ?? NATIVE_SCROLL_PLUGIN}`, "--name", "matrix-scroll-v1", JSON.stringify(payload)], 3_000);
  if (Buffer.byteLength(output) > 512) throw new Error("Native scroll reply exceeds limit");
  return TerminalScrollStateSchema.parse(JSON.parse(output.trim()));
}
