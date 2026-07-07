import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createMDX } from 'fumadocs-mdx/next';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactCompiler: true,
  transpilePackages: ["@matrix-os/clerk-sync", "@matrix-os/observability"],
  async rewrites() {
    return [
      {
        source: '/docs/:path*.mdx',
        destination: '/llms.mdx/docs/:path*',
      },
      // Same-origin PostHog proxy. uBlock's default privacy list blocks
      // "/ingest/*^ip=" (a known PostHog proxy signature), so new bundles use
      // /relay; the /ingest rules stay for cached bundles that still point at it.
      {
        source: '/relay/static/:path*',
        destination: 'https://eu-assets.i.posthog.com/static/:path*',
      },
      {
        source: '/relay/array/:path*',
        destination: 'https://eu-assets.i.posthog.com/array/:path*',
      },
      {
        source: '/relay/:path*',
        destination: 'https://eu.i.posthog.com/:path*',
      },
      {
        source: '/ingest/static/:path*',
        destination: 'https://eu-assets.i.posthog.com/static/:path*',
      },
      {
        source: '/ingest/:path*',
        destination: 'https://eu.i.posthog.com/:path*',
      },
    ];
  },
  async redirects() {
    return [
      // Docs IA change (spec 100): user pages flattened to /docs root, and
      // deployment folded under /docs/developer. Keep legacy links alive.
      { source: '/docs/users/:path*', destination: '/docs/:path*', permanent: true },
      { source: '/docs/users', destination: '/docs', permanent: true },
      {
        source: '/docs/deployment/:path*',
        destination: '/docs/developer/deployment/:path*',
        permanent: true,
      },
      {
        source: '/docs/deployment',
        destination: '/docs/developer/deployment',
        permanent: true,
      },
    ];
  },
  skipTrailingSlashRedirect: true,
  turbopack: {
    root: resolve(__dirname, ".."),
  },
};

const withMDX = createMDX();

// PostHog source-map upload runs only when build credentials are present so
// uploads happen in release builds while builds without credentials stay
// byte-identical to today. withPostHogConfig must stay the OUTERMOST wrapper
// (wrapping it in withMDX would drop its build hooks; the package warns).
// @posthog/nextjs-config is a devDependency, so it MUST NOT be imported at
// module top level: `next start` loads this file at runtime in pruned
// production images where dev deps are absent.
const posthogPersonalApiKey = process.env.POSTHOG_API_KEY;
const posthogProjectId = process.env.POSTHOG_PROJECT_ID;

function withSourcemapUpload(config: NextConfig): NextConfig {
  if (!posthogPersonalApiKey || !posthogProjectId) return config;
  const require = createRequire(import.meta.url);
  const { withPostHogConfig } = require('@posthog/nextjs-config') as typeof import('@posthog/nextjs-config');
  return withPostHogConfig(config, {
    personalApiKey: posthogPersonalApiKey,
    projectId: posthogProjectId,
    // Private API host (not the ingestion host): EU is https://eu.posthog.com.
    host: process.env.POSTHOG_HOST ?? 'https://eu.posthog.com',
    sourcemaps: { enabled: true },
  });
}

export default withSourcemapUpload(withMDX(nextConfig));
