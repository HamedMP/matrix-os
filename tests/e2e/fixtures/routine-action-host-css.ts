import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, realpath } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";

export const routineHosts = ["web", "electron"] as const;
export type RoutineHost = typeof routineHosts[number];
const root = resolve(__dirname, "../../..");
const hosts = {
  web: { entry: "shell/src/app/globals.css", scanRoot: "shell", package: "shell/package.json", plugin: "@tailwindcss/postcss" },
  electron: { entry: "desktop/src/renderer/src/design/index.css", scanRoot: "desktop/src/renderer", package: "desktop/package.json", plugin: "@tailwindcss/vite" },
};
const component = join(root, "packages/ui/src/routine-action/RoutineActionConfirmation.tsx");
const theme = join(root, "packages/ui/src/chat-agents/theme.ts");

/** Compile shipped host CSS and its declared sources, never a workspace-wide test scan. */
export async function compileRoutineHostCss(host: RoutineHost, omitRoutineSource = false) {
  // Follow the host's declared plugin dependency edges, including shared-install
  // worktrees. Electron and Web need not use the same compiler/scanner version.
  const installedRoot = resolve(await realpath(join(root, "node_modules")), "..");
  const require = createRequire(join(installedRoot, hosts[host].package));
  const pluginEntry = require.resolve(hosts[host].plugin);
  const pluginRequire = createRequire(pluginEntry);
  const { compile } = pluginRequire("@tailwindcss/node") as typeof import("@tailwindcss/node");
  const { Scanner } = pluginRequire("@tailwindcss/oxide") as typeof import("@tailwindcss/oxide");
  const version = async (entry: string) => (JSON.parse(await readFile(resolve(dirname(entry), "../package.json"), "utf8")) as { version: string }).version;
  const toolchain = { plugin: hosts[host].plugin, pluginVersion: await version(pluginEntry),
    nodeVersion: await version(pluginRequire.resolve("@tailwindcss/node")),
    oxideVersion: (pluginRequire("@tailwindcss/oxide/package.json") as { version: string }).version };
  const entry = join(root, hosts[host].entry);
  let source = await readFile(entry, "utf8");
  if (omitRoutineSource) source = source.replace(/^@source "[^"\n]*\/routine-action";\n/m, "");
  // Web RootLayout imports its shipped local font faces immediately before globals.
  if (host === "web") source = '@import "./fonts.css";\n' + source;
  const options = { base: dirname(entry), from: entry, shouldRewriteUrls: true, onDependency() {} };
  const compiler = await compile(source, options);
  const scanner = new Scanner({ sources: [
    ...(compiler.root === "none" ? [] : [{ ...(compiler.root ?? { base: join(root, hosts[host].scanRoot), pattern: "**/*" }), negated: false }]),
    ...compiler.sources,
  ] });
  const candidates = scanner.scan();
  const found = new Set(scanner.files);
  // Qualify this component's own formatting independently of coincidental utility
  // duplicates elsewhere in an app. Both files must first be discovered by the host.
  const scopedFiles = [component, theme].filter(file => found.has(file));
  const scoped = new Scanner({ sources: [] }).scanFiles(await Promise.all(scopedFiles.map(async file => ({
    content: await readFile(file, "utf8"), extension: extname(file).slice(1),
  }))));
  const componentCss = (await compile(source, options)).build(scoped);
  let css = compiler.build(candidates);
  const fonts = new Map<string, Buffer>();
  // Serve only shipped Geist font bytes through closed fixture routes. No network
  // font fallback or filesystem-serving endpoint participates in these screenshots.
  for (const match of [...css.matchAll(/url\((?:["']([^"']+)["']|([^)'"\s]+))\)/g)]) {
    const url = match[1] ?? match[2]!;
    if (!/geist/i.test(url) || !/\.(woff2?|ttf)$/.test(url) || /^(?:data:|https?:)/.test(url)) continue;
    const specifier = decodeURIComponent(url).split("node_modules/").at(-1)!;
    const path = specifier.startsWith("@") ? require.resolve(specifier) : resolve(dirname(entry), specifier);
    const bytes = await readFile(path), id = createHash("sha256").update(bytes).digest("hex") + extname(path);
    fonts.set(id, bytes);
    css = css.split(match[0]).join(`url("/__fixture-font/${id}")`);
  }
  if (!fonts.size) throw new Error(`Shipped ${host} Geist fonts are unavailable`);
  return { css, fonts, componentCss, componentDiscovered: found.has(component), scannedFiles: found.size, toolchain };
}

export const hasRoutinePreFormatting = (css: string) => /\.whitespace-pre-wrap\s*\{\s*white-space:\s*pre-wrap/.test(css);
