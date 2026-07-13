import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { NextConfig } from "next";

const gatewayUrl = process.env.GATEWAY_URL ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  reactCompiler: true,
  transpilePackages: ["@matrix-os/contracts", "@matrix-os/observability"],
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      // Workspace packages use NodeNext `.js` specifiers while exporting
      // TypeScript source. Resolve those specifiers before transpilation.
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
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
  // Workspace packages (e.g. @matrix-os/contracts) are consumed as TS source
  // and use nodenext module resolution, so their relative imports carry .js
  // extensions ("./agent-profile.js" -> agent-profile.ts). Turbopack maps
  // that natively; webpack needs extensionAlias or the production build
  // fails with "Module not found: Can't resolve './agent-profile.js'".
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
    };
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
