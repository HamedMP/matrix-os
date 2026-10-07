const { getDefaultConfig } = require("expo/metro-config");
const fs = require("fs");
const os = require("os");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");
const pnpmLinksRoot = path.join(os.homedir(), "Library", "pnpm", "store", "v10", "links");

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(projectRoot);
const defaultResolveRequest = config.resolver?.resolveRequest;

function resolveFromMobileApp(moduleName) {
  return require.resolve(moduleName, { paths: [projectRoot] });
}

// Metro stats every watch folder and throws on a missing one. The pnpm global
// store only exists on macOS dev machines; on Linux (CI, EAS workers) packages
// live under the workspace root instead, so the folder is simply dropped there.
config.watchFolders = Array.from(new Set([
  ...(config.watchFolders ?? []),
  workspaceRoot,
  pnpmLinksRoot,
])).filter((folder) => fs.existsSync(folder));
config.serializer = {
  ...config.serializer,
  polyfillModuleNames: [
    ...(config.serializer?.polyfillModuleNames ?? []),
    path.resolve(projectRoot, "lib/hermes-polyfills.ts"),
  ],
};
config.resolver = {
  ...config.resolver,
  nodeModulesPaths: [
    path.resolve(projectRoot, "node_modules"),
    path.resolve(workspaceRoot, "node_modules"),
  ],
  extraNodeModules: {
    ...(config.resolver?.extraNodeModules ?? {}),
    react: path.resolve(projectRoot, "node_modules/react"),
    "react-dom": path.resolve(projectRoot, "node_modules/react-dom"),
    "react-native": path.resolve(projectRoot, "node_modules/react-native"),
  },
  resolveRequest(context, moduleName, platform) {
    if (moduleName === "react" || moduleName.startsWith("react/")) {
      return {
        type: "sourceFile",
        filePath: resolveFromMobileApp(moduleName),
      };
    }

    if (defaultResolveRequest) {
      return defaultResolveRequest(context, moduleName, platform);
    }

    return context.resolveRequest(context, moduleName, platform);
  },
};

module.exports = config;
