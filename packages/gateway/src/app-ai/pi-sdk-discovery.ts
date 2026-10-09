import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod/v4";
import type { PiAuthDiscovery } from "../ai-providers/pi-settings-auth.js";
export interface PiAppSdkDiscovery extends PiAuthDiscovery { authStorageEntry?: string }
/** App inference verifies its own audited SDK version. The public runtime is
 * paired with that version's fixed native lock backend, which is deliberately
 * not a user extension. New versions fail closed until their protocol is tested. */
export async function discoverPiAppSdk(options: {
  homePath: string; runtimePrefix?: string; env: Record<string, string>;
}): Promise<PiAppSdkDiscovery> {
  const prefix = resolve(options.runtimePrefix ?? "/opt/matrix/runtime/node");
  const root = join(prefix, "lib/node_modules/@earendil-works/pi-coding-agent");
  const metadata = join(root, "package.json");
  const info = await lstat(metadata);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) throw Error("App AI SDK unavailable");
  const pkg = z.object({ name: z.literal("@earendil-works/pi-coding-agent"), version: z.literal("1.0.4") }).parse(JSON.parse(await readFile(metadata, "utf8")));
  const realRoot = await realpath(root);
  async function ownedEntry(path: string) {
    const value = await realpath(path);
    if (!value.startsWith(`${realRoot}/`)) throw Error("App AI SDK unavailable");
    const file = await lstat(value); if (!file.isFile() || file.isSymbolicLink()) throw Error("App AI SDK unavailable");
    return value;
  }
  const cli = join(prefix, "bin/pi");
  if (await realpath(cli) !== await ownedEntry(join(root, "dist/bundle/cli.js"))) throw Error("App AI SDK unavailable");
  const entry = await ownedEntry(join(root, "dist/index.js"));
  const authStorageEntry = await ownedEntry(join(root, "dist/core/auth-storage.js"));
  const env: Record<string, string> = { HOME: resolve(options.homePath), PI_OFFLINE: "1", PI_TELEMETRY: "0" };
  for (const key of ["PATH", "LANG", "LC_ALL"]) if (options.env[key]) env[key] = options.env[key]!;
  const version = await promisify(execFile)(cli, ["--version"], { cwd: env.HOME, env, timeout: 5000, maxBuffer: 4096, encoding: "utf8", windowsHide: true });
  if (version.stdout.trim() !== pkg.version) throw Error("App AI SDK unavailable");
  return { node: join(prefix, "bin/node"), entry: pathToFileURL(entry).href, authStorageEntry: pathToFileURL(authStorageEntry).href, env, cwd: env.HOME };
}
