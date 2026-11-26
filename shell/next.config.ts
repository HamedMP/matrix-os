import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { NextConfig } from "next";

const requireFromShell = createRequire(import.meta.url);

function isPrivatePreviewHandle(handle: string): boolean {
  // Host bundles include the source file but strip shell/node_modules.
  const contract = requireFromShell("../packages/contracts/src/private-preview.ts") as typeof import("../packages/contracts/src/private-preview");
  return contract.isPrivatePreviewHandle(handle);
}

const gatewayUrl = process.env.GATEWAY_URL ?? "http://localhost:4000";
const platformShellAssetPrefix = process.env.MATRIX_PLATFORM_AUTH_SHELL === "1"
  ? "/__platform-shell"
  : undefined;
const runtimeHandle = process.env.MATRIX_HANDLE;
const privatePreviewAssetPrefix = process.env.NODE_ENV === "production"
  && process.env.MATRIX_PREVIEW_RUNTIME === "true"
  && runtimeHandle && runtimeHandle === process.env.MATRIX_RUNTIME_SLOT
  && isPrivatePreviewHandle(runtimeHandle)
  ? `/vm/${runtimeHandle}`
  : undefined;
const localParityBuild = process.env.MATRIX_LOCAL_PARITY_BUILD === "1";

type CssLoader = string | { loader?: string; options?: string | { publicPath?: string } };
type CssRule = string | { use?: CssLoader | CssLoader[]; rules?: CssRule[]; oneOf?: CssRule[] };

function setRelativeCssAssetPaths(rules: CssRule[], extractionLoader: string): void {
  for (const rule of rules) {
    if (!rule || typeof rule !== "object") continue;
    const loaders = Array.isArray(rule.use) ? rule.use : [rule.use];
    for (const loader of loaders) {
      if (!loader || typeof loader !== "object" || loader.loader !== extractionLoader ||
        !loader.options || typeof loader.options !== "object" || loader.options.publicPath !== "/_next/") continue;
      loader.options.publicPath = "auto";
    }
    setRelativeCssAssetPaths([...(rule.rules ?? []), ...(rule.oneOf ?? [])], extractionLoader);
  }
}

type NextWebpack = Parameters<NonNullable<NextConfig["webpack"]>>[1]["webpack"];
type WebpackCompiler = { hooks: { thisCompilation: { tap(name: string, fn: (compilation: never) => void): void } } };

const RUNTIME_PUBLIC_PATH_PLUGIN = "MatrixRuntimePublicPathPlugin";

// Next copies output.publicPath into each client reference manifest and
// prefixes server-rendered chunk tags with it, so output.publicPath must stay
// the built absolute "/_next/" string ("auto" rendered "autostatic/chunks/...").
// Lazy chunks instead resolve from the URL the Webpack runtime was served from,
// so one host bundle works at "/" and under an assigned Preview URL path.
function runtimePublicPathPlugin(webpack: NextWebpack) {
  const { RuntimeGlobals, RuntimeModule } = webpack;
  class RuntimePublicPathModule extends RuntimeModule {
    constructor() {
      // Attach runs after the static public-path module and overrides it.
      super("matrix runtime public path", RuntimeModule.STAGE_ATTACH);
    }

    generate(): string {
      return [
        "var matrixScript = typeof document !== \"undefined\" ? document.currentScript : null;",
        "var matrixSrc = matrixScript && String(matrixScript.tagName).toUpperCase() === \"SCRIPT\" ? matrixScript.src : \"\";",
        "var matrixStatic = matrixSrc ? matrixSrc.indexOf(\"/_next/static/\") : -1;",
        `if (matrixStatic >= 0) ${RuntimeGlobals.publicPath} = matrixSrc.slice(0, matrixStatic) + "/_next/";`,
      ].join("\n");
    }
  }
  return {
    apply(compiler: WebpackCompiler) {
      compiler.hooks.thisCompilation.tap(RUNTIME_PUBLIC_PATH_PLUGIN, (compilation: never) => {
        const typed = compilation as unknown as {
          hooks: { runtimeRequirementInTree: { for(key: string): { tap(name: string, fn: (chunk: unknown) => void): void } } };
          addRuntimeModule(chunk: unknown, module: InstanceType<typeof RuntimeModule>): void;
        };
        typed.hooks.runtimeRequirementInTree.for(RuntimeGlobals.publicPath).tap(RUNTIME_PUBLIC_PATH_PLUGIN, chunk => {
          typed.addRuntimeModule(chunk, new RuntimePublicPathModule());
        });
      });
    },
  };
}

const nextConfig: NextConfig = {
  assetPrefix: platformShellAssetPrefix ?? privatePreviewAssetPrefix,
  // Next includes this value on Server Action requests from this build.
  deploymentId: platformShellAssetPrefix
    ? `${platformShellAssetPrefix.slice(1)}-${process.env.NEXT_PUBLIC_MATRIX_BUILD_SHA || "local"}`
    : undefined,
  env: {
    NEXT_PUBLIC_PLATFORM_SHELL_ASSET_PREFIX: platformShellAssetPrefix ?? "",
  },
  reactCompiler: true,
  // The required source-extension hook disables Next's automatic build worker.
  // Explicit workers allow server/edge compilation and tracing to overlap.
  experimental: {
    webpackBuildWorker: true,
    parallelServerCompiles: true,
    parallelServerBuildTraces: true,
    // Avoid traversing thousands of unused icon re-exports in both bundles.
    optimizePackageImports: ["@hugeicons/core-free-icons"],
    ...(localParityBuild
      ? {
          // The amd64 parity builder runs under Rosetta on developer Macs. Keep
          // the emitted production bundle unchanged while bounding peak build
          // memory using the controls recommended by Next.js.
          webpackMemoryOptimizations: true,
          staticGenerationMaxConcurrency: 1,
          staticGenerationMinPagesPerWorker: 100,
        }
      : {}),
  },
  transpilePackages: ["@matrix-os/contracts", "@matrix-os/observability", "@matrix-os/ui"],
  // Allow HMR websockets when the dev shell is reached through a tunnel
  // (staging/dev.matrix-os.com) rather than localhost. Next 16 blocks dev
  // resources on cross-origin hostnames by default.
  allowedDevOrigins: [
    "staging.matrix-os.com",
    "dev.matrix-os.com",
    "localhost",
    "127.0.0.1",
  ],
  // Next's default trailing-slash 308 redirect breaks spec 063 app-runtime:
  // the iframe navigates to /apps/{slug}/ (trailing slash), Next 308s to
  // /apps/{slug} (no slash), and the browser drops the cookie because its
  // Path=/apps/{slug}/ no longer matches. Keep the slash so proxy.ts can
  // forward the URL verbatim to the gateway dispatcher.
  skipTrailingSlashRedirect: true,
  turbopack: {
    root: resolve(__dirname, ".."),
  },
  // Production builds still use webpack. Some NodeNext workspace packages are
  // consumed as TS source with emitted .js specifiers, so webpack needs this
  // alias while Turbopack development consumes bundler-style source imports.
  webpack: (config, { dev, isServer, webpack }) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
    };
    // The host bundle is built once, then Next serves it under the assigned
    // Preview URL. Resolve lazy chunks from the loaded Webpack runtime script.
    if (dev === false && isServer === false && !platformShellAssetPrefix) {
      config.plugins = [...(config.plugins ?? []), runtimePublicPathPlugin(webpack)];
      // Keep fonts and other media relative to the emitted stylesheet URL.
      const extractionLoader = requireFromShell.resolve("next/dist/compiled/mini-css-extract-plugin/loader");
      setRelativeCssAssetPaths(config.module?.rules ?? [], extractionLoader);
    }
    return config;
  },
  async rewrites() {
    return [
      // Same-origin PostHog proxy. Ad blockers blocklist *.posthog.com and
      // known proxy paths (/ingest, /ingress, /hog ship in uBlock's default
      // privacy list), so analytics must ride an unremarkable first-party
      // path on every shell origin. Asset rules must precede the catch-all.
      {
        source: "/relay/static/:path*",
        destination: "https://eu-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/relay/array/:path*",
        destination: "https://eu-assets.i.posthog.com/array/:path*",
      },
      {
        source: "/relay/:path*",
        destination: "https://eu.i.posthog.com/:path*",
      },
      {
        source: "/gateway/:path*",
        destination: `${gatewayUrl}/:path*`,
      },
      {
        source: "/health",
        destination: `${gatewayUrl}/health`,
      },
      {
        source: "/api/:path*",
        destination: `${gatewayUrl}/api/:path*`,
      },
      {
        source: "/icons/:path*",
        destination: `${gatewayUrl}/files/system/icons/:path*`,
      },
      {
        source: "/files/:path*",
        destination: `${gatewayUrl}/files/:path*`,
      },
      {
        source: "/modules/:path*",
        destination: `${gatewayUrl}/modules/:path*`,
      },
      {
        source: "/apps/:path*",
        destination: `${gatewayUrl}/apps/:path*`,
      },
      {
        source: "/ws",
        destination: `${gatewayUrl}/ws`,
      },
      {
        source: "/ws/:path*",
        destination: `${gatewayUrl}/ws/:path*`,
      },
    ];
  },
};

// PostHog source-map upload runs only when build credentials are present so
// uploads happen in release builds while local/dev builds stay byte-identical
// to a build without the plugin (the plain object is exported unchanged).
// @posthog/nextjs-config is a devDependency, so it MUST NOT be imported at
// module top level: `next start` loads this file at runtime in pruned
// production images (platform Cloud Run) where dev deps are absent.
const posthogPersonalApiKey = process.env.POSTHOG_API_KEY;
const posthogProjectId = process.env.POSTHOG_PROJECT_ID;

function withSourcemapUpload(config: NextConfig): NextConfig {
  if (!posthogPersonalApiKey || !posthogProjectId) return config;
  const require = createRequire(import.meta.url);
  const { withPostHogConfig } = require("@posthog/nextjs-config") as typeof import("@posthog/nextjs-config");
  return withPostHogConfig(config, {
    personalApiKey: posthogPersonalApiKey,
    projectId: posthogProjectId,
    // Private API host (not the ingestion host): EU is https://eu.posthog.com.
    host: process.env.POSTHOG_HOST ?? "https://eu.posthog.com",
    sourcemaps: { enabled: true },
  });
}

export default withSourcemapUpload(nextConfig);
