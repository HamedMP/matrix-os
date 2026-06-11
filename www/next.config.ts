import { createMDX } from 'fumadocs-mdx/next';
import type { NextConfig } from 'next';
import { withPostHogConfig } from '@posthog/nextjs-config';

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
  skipTrailingSlashRedirect: true,
};

const withMDX = createMDX();

// PostHog source-map upload runs only when build credentials are present so
// uploads happen in release builds while builds without credentials stay
// byte-identical to today. withPostHogConfig must stay the OUTERMOST wrapper
// (wrapping it in withMDX would drop its build hooks; the package warns).
const posthogPersonalApiKey = process.env.POSTHOG_API_KEY;
const posthogProjectId = process.env.POSTHOG_PROJECT_ID;

export default posthogPersonalApiKey && posthogProjectId
  ? withPostHogConfig(withMDX(nextConfig), {
      personalApiKey: posthogPersonalApiKey,
      projectId: posthogProjectId,
      // Private API host (not the ingestion host): EU is https://eu.posthog.com.
      host: process.env.POSTHOG_HOST ?? process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://eu.posthog.com',
      sourcemaps: { enabled: true },
    })
  : withMDX(nextConfig);
