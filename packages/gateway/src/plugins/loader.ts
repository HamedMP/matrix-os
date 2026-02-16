import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import type {
  PluginManifest,
  PluginOrigin,
  DiscoveredPlugin,
  PluginModule,
  LoadedPlugin,
} from "./types.js";
import { validateManifest } from "./manifest.js";
import { createPluginApi, type CreatePluginApiOpts } from "./api.js";
import type { PluginRegistry } from "./registry.js";
import { checkOriginTrust, scanPluginCode, auditRegistration } from "./security.js";

const MANIFEST_FILE = "matrixos.plugin.json";

function readManifest(dir: string): PluginManifest | null {
  const manifestPath = join(dir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
    return validateManifest(raw);
  } catch {
    return null;
  }
}

export function discoverPlugins(opts: {
  homePath: string;
  projectRoot?: string;
  configPaths?: string[];
}): DiscoveredPlugin[] {
  const { homePath, projectRoot, configPaths = [] } = opts;
  const seen = new Set<string>();
  const results: DiscoveredPlugin[] = [];

  function add(dir: string, origin: PluginOrigin) {
    const manifest = readManifest(dir);
    if (!manifest) return;
    if (seen.has(manifest.id)) return;
    seen.add(manifest.id);
    results.push({ manifest, path: resolve(dir), origin });
  }

  // 1. Bundled: project packages with matrixos.plugin.json
  if (projectRoot) {
    const packagesDir = join(projectRoot, "packages");
    if (existsSync(packagesDir)) {
      try {
        for (const entry of readdirSync(packagesDir)) {
          const pkgDir = join(packagesDir, entry);
          add(pkgDir, "bundled");
        }
      } catch { /* skip */ }
    }
  }

  // 2. Workspace: ~/plugins/*/
  const pluginsDir = join(homePath, "plugins");
  if (existsSync(pluginsDir)) {
    try {
      for (const entry of readdirSync(pluginsDir)) {
        const pluginDir = join(pluginsDir, entry);
        add(pluginDir, "workspace");
      }
    } catch { /* skip */ }
  }

  // 3. Config: explicit paths
  for (const configPath of configPaths) {
    const absPath = resolve(configPath);
    add(absPath, "config");
  }

  return results;
}

function resolveEntryPoint(pluginDir: string): string | null {
  const candidates = [
    join(pluginDir, "index.ts"),
    join(pluginDir, "index.js"),
    join(pluginDir, "index.mjs"),
    join(pluginDir, "src/index.ts"),
    join(pluginDir, "src/index.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function loadPlugin(
  discovered: DiscoveredPlugin,
  registry: PluginRegistry,
  systemConfig: Record<string, unknown>,
  homePath: string,
  pluginConfigs?: Record<string, Record<string, unknown>>,
): Promise<LoadedPlugin> {
  const start = Date.now();
  const { manifest, path: pluginDir, origin } = discovered;

  const trust = checkOriginTrust(origin);
  if (trust.warnOnLoad) {
    console.warn(`[plugin:${manifest.id}] WARNING: Plugin from config origin -- not fully trusted`);
  }

  const scanResults = scanPluginCode(pluginDir);
  for (const scan of scanResults) {
    if (scan.suspicious) {
      console.warn(
        `[plugin:${manifest.id}] Suspicious code in ${scan.file}: ${scan.patterns.join(", ")}`,
      );
    }
  }

  const entryPoint = resolveEntryPoint(pluginDir);
  if (!entryPoint) {
    return {
      manifest,
      path: pluginDir,
      origin,
      status: "error",
      error: "No entry point found (index.ts, index.js, or src/index.ts)",
      loadTimeMs: Date.now() - start,
    };
  }

  try {
    const mod = await import(entryPoint);
    const pluginModule: PluginModule = mod.default ?? mod;

    const api = createPluginApi({
      manifest,
      pluginDir,
      homePath,
      systemConfig,
      pluginConfig: pluginConfigs?.[manifest.id],
      registry,
    });

    if (typeof pluginModule === "function") {
      await pluginModule(api);
    } else if (typeof pluginModule.register === "function") {
      await pluginModule.register(api);
    } else {
      throw new Error("Plugin module must export a register function or be a function");
    }

    console.log(auditRegistration(manifest.id, "loaded", `origin=${origin}, loadTimeMs=${Date.now() - start}`));

    return {
      manifest,
      path: pluginDir,
      origin,
      status: "loaded",
      loadTimeMs: Date.now() - start,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[plugin:${manifest.id}] Failed to load: ${errMsg}`);
    return {
      manifest,
      path: pluginDir,
      origin,
      status: "error",
      error: errMsg,
      loadTimeMs: Date.now() - start,
    };
  }
}

export async function loadAllPlugins(opts: {
  homePath: string;
  projectRoot?: string;
  configPaths?: string[];
  registry: PluginRegistry;
  systemConfig: Record<string, unknown>;
  pluginConfigs?: Record<string, Record<string, unknown>>;
}): Promise<LoadedPlugin[]> {
  const discovered = discoverPlugins({
    homePath: opts.homePath,
    projectRoot: opts.projectRoot,
    configPaths: opts.configPaths,
  });

  const results: LoadedPlugin[] = [];
  for (const plugin of discovered) {
    const loaded = await loadPlugin(
      plugin,
      opts.registry,
      opts.systemConfig,
      opts.homePath,
      opts.pluginConfigs,
    );
    results.push(loaded);
  }

  return results;
}
