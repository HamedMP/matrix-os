const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(projectRoot);
const defaultResolveRequest = config.resolver?.resolveRequest;

function resolveFromMobileApp(moduleName) {
  return require.resolve(moduleName, { paths: [projectRoot] });
}

config.watchFolders = Array.from(new Set([...(config.watchFolders ?? []), workspaceRoot]));
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
