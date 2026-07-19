import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import { MATRIX_TELEMETRY_EVENTS, type MatrixTelemetryEvent } from '@matrix-os/observability';

import {
  getHostBundleRelease,
  getHostBundleReleaseByChannel,
  HostBundleReleaseConflictError,
  listHostBundleReleases,
  promoteHostBundleChannel,
  upsertHostBundleRelease,
  type HostBundleReleaseRecord,
  type PlatformDB,
} from './db.js';
import type { CustomerVpsObjectStore } from './customer-vps-r2.js';
import { timingSafeTokenEquals } from './platform-token.js';

const HOST_BUNDLE_READ_TIMEOUT_MS = 30_000;
const HOST_BUNDLE_IMAGE_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const HOST_BUNDLE_FILES = new Set([
  'matrix-host-bundle.tar.gz',
  'matrix-host-bundle.tar.gz.sha256',
  'incremental-manifest.json',
  'manifest.json',
  'release.json',
]);
const HOST_BUNDLE_CHANNEL_PATTERN = /^(stable|canary|dev|beta)$/;
const HOST_BUNDLE_CHANNEL_FILE_PATTERN = /^(stable|canary|dev|beta)\.json$/;

const HostBundleReleaseBodySchema = z.object({
  version: z.string().regex(HOST_BUNDLE_IMAGE_VERSION_PATTERN),
  gitCommit: z.string().min(7).max(64),
  gitRef: z.string().max(256).nullable().optional(),
  buildTime: z.string().datetime({ offset: true })
    .transform((value) => new Date(value).toISOString()),
  bundleKey: z.string().regex(/^system-bundles\/[A-Za-z0-9._-]{1,128}\/matrix-host-bundle\.tar\.gz$/),
  checksumKey: z.string().regex(/^system-bundles\/[A-Za-z0-9._-]{1,128}\/matrix-host-bundle\.tar\.gz\.sha256$/).nullable().optional(),
  incrementalManifestKey: z.string().regex(/^system-bundles\/[A-Za-z0-9._-]{1,128}\/incremental-manifest\.json$/).nullable().optional(),
  incrementalManifestSha256: z.string().regex(/^[a-f0-9]{64}$/i).nullable().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  size: z.number().int().positive(),
  severity: z.enum(['normal', 'security']).optional(),
  updateType: z.enum(['manual', 'auto']).optional(),
  changelog: z.string().max(32_000).nullable().optional(),
  channel: z.string().regex(HOST_BUNDLE_CHANNEL_PATTERN).optional(),
});

const HostBundleChannelBodySchema = z.object({
  version: z.string().regex(HOST_BUNDLE_IMAGE_VERSION_PATTERN),
});

function isObjectNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return candidate.name === 'NoSuchKey' ||
    candidate.name === 'NotFound' ||
    candidate.$metadata?.httpStatusCode === 404;
}

function hostBundleReleaseResponse(
  release: HostBundleReleaseRecord,
  url?: string,
  channel?: string,
): Record<string, unknown> {
  return {
    version: release.version,
    channel: channel ?? release.channel,
    gitCommit: release.gitCommit,
    gitRef: release.gitRef,
    buildTime: release.buildTime,
    bundleKey: release.bundleKey,
    checksumKey: release.checksumKey,
    incrementalManifestKey: release.incrementalManifestKey,
    incrementalManifestSha256: release.incrementalManifestSha256,
    sha256: release.sha256,
    bundleSha256: release.sha256,
    size: release.size,
    severity: release.severity,
    updateType: release.updateType,
    changelog: release.changelog,
    createdAt: release.createdAt,
    ...(url ? { url } : {}),
  };
}

function bearerTokenEquals(authHeader: string | undefined, expected: string): boolean {
  if (!authHeader?.startsWith('Bearer ')) {
    return false;
  }
  return timingSafeTokenEquals(authHeader.slice(7), expected);
}

export function createHostBundleRoutes(opts: {
  db: PlatformDB;
  platformSecret: string;
  adminBodyLimit: number;
  getHostBundleObjectStore: () => CustomerVpsObjectStore | undefined;
  capturePlatformEvent: (
    event: MatrixTelemetryEvent,
    properties: Record<string, string | number | boolean | null | undefined>,
  ) => void;
  logRouteError: (route: string, err: unknown) => void;
}) {
  const { db, platformSecret, capturePlatformEvent, logRouteError } = opts;
  const routes = new Hono();

  function getHostBundleObjectStore(): CustomerVpsObjectStore | undefined {
    return opts.getHostBundleObjectStore();
  }

  async function getSignedBundleUrl(release: HostBundleReleaseRecord): Promise<string> {
    return getSignedHostBundleObjectUrl(release.bundleKey);
  }

  async function getSignedHostBundleObjectUrl(key: string): Promise<string> {
    const hostBundleObjectStore = getHostBundleObjectStore();
    if (!hostBundleObjectStore) {
      throw new Error('Host bundle storage unavailable');
    }
    if (!hostBundleObjectStore.getPresignedGetUrl) {
      throw new Error('Host bundle storage cannot create signed URLs');
    }
    return hostBundleObjectStore.getPresignedGetUrl(key, 3600);
  }

  function requireHostBundleAdmin(c: Context): Response | null {
    if (!platformSecret) {
      return c.json({ error: 'Platform admin not configured' }, 503);
    }
    if (!bearerTokenEquals(c.req.header('authorization'), platformSecret)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return null;
  }

  routes.get('/releases', async (c) => {
    const channel = c.req.query('channel');
    if (channel !== undefined && !HOST_BUNDLE_CHANNEL_PATTERN.test(channel)) {
      return c.json({ error: 'Invalid request' }, 400);
    }
    try {
      const releases = await listHostBundleReleases(db, 100, channel);
      return c.json({
        generatedAt: new Date().toISOString(),
        releases: releases.map((release) => hostBundleReleaseResponse(release)),
      });
    } catch (err: unknown) {
      logRouteError('/system-bundles/releases', err);
      return c.json({ error: 'Host bundle unavailable' }, 502);
    }
  });

  routes.get('/releases/:versionJson', async (c) => {
    const versionJson = c.req.param('versionJson');
    const version = versionJson.endsWith('.json') ? versionJson.slice(0, -5) : versionJson;
    if (!HOST_BUNDLE_IMAGE_VERSION_PATTERN.test(version)) {
      return c.json({ error: 'Invalid request' }, 400);
    }
    try {
      const release = await getHostBundleRelease(db, version);
      if (!release) {
        return c.json({ error: 'Not found' }, 404);
      }
      const url = await getSignedBundleUrl(release);
      return c.json(hostBundleReleaseResponse(release, url), 200, {
        'cache-control': 'private, max-age=30',
      });
    } catch (err: unknown) {
      logRouteError('/system-bundles/releases/:version', err);
      return c.json({ error: 'Host bundle unavailable' }, 502);
    }
  });

  routes.post('/releases', bodyLimit({ maxSize: opts.adminBodyLimit }), async (c) => {
    const authError = requireHostBundleAdmin(c);
    if (authError) return authError;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err: unknown) {
      logRouteError('/system-bundles/releases parse', err);
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const parsed = HostBundleReleaseBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid request' }, 400);
    }
    try {
      const release = await upsertHostBundleRelease(db, parsed.data);
      let channel;
      if (parsed.data.channel) {
        channel = await promoteHostBundleChannel(db, parsed.data.channel, release.version);
        capturePlatformEvent(MATRIX_TELEMETRY_EVENTS.HOST_BUNDLE_CHANNEL_PROMOTED, {
          channel: parsed.data.channel,
          version: release.version,
          gitCommit: release.gitCommit,
        });
      }
      capturePlatformEvent(MATRIX_TELEMETRY_EVENTS.HOST_BUNDLE_RELEASE_REGISTERED, {
        version: release.version,
        gitCommit: release.gitCommit,
        gitRef: release.gitRef,
        bundleKey: release.bundleKey,
        size: release.size,
        severity: release.severity,
        updateType: release.updateType,
      });
      return c.json({
        release: hostBundleReleaseResponse(release),
        ...(channel ? { channel } : {}),
      });
    } catch (err: unknown) {
      if (err instanceof HostBundleReleaseConflictError) {
        return c.json({ error: 'Release already exists with different artifact metadata' }, 409);
      }
      logRouteError('/system-bundles/releases', err);
      return c.json({ error: 'Host bundle unavailable' }, 502);
    }
  });

  routes.post('/channels/:channel', bodyLimit({ maxSize: opts.adminBodyLimit }), async (c) => {
    const authError = requireHostBundleAdmin(c);
    if (authError) return authError;
    const channel = c.req.param('channel');
    if (!HOST_BUNDLE_CHANNEL_PATTERN.test(channel)) {
      return c.json({ error: 'Invalid request' }, 400);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err: unknown) {
      logRouteError('/system-bundles/channels parse', err);
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const parsed = HostBundleChannelBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid request' }, 400);
    }
    try {
      const promoted = await promoteHostBundleChannel(db, channel, parsed.data.version);
      capturePlatformEvent(MATRIX_TELEMETRY_EVENTS.HOST_BUNDLE_CHANNEL_PROMOTED, {
        channel,
        version: promoted.version,
      });
      return c.json(promoted);
    } catch (err: unknown) {
      logRouteError('/system-bundles/channels/:channel promote', err);
      return c.json({ error: 'Host bundle unavailable' }, 502);
    }
  });

  routes.get('/objects/sha256/:sha256', async (c) => {
    const hostBundleObjectStore = getHostBundleObjectStore();
    if (!hostBundleObjectStore) {
      return c.json({ error: 'Host bundle storage unavailable' }, 503);
    }

    const sha256 = c.req.param('sha256');
    if (!/^[a-f0-9]{64}$/i.test(sha256)) {
      return c.json({ error: 'Invalid request' }, 400);
    }

    const objectKey = `system-bundles/objects/sha256/${sha256.toLowerCase()}`;
    if (hostBundleObjectStore.getPresignedGetUrl) {
      try {
        const url = await getSignedHostBundleObjectUrl(objectKey);
        return c.redirect(url, 302);
      } catch (err: unknown) {
        if (isObjectNotFoundError(err)) {
          return c.json({ error: 'Not found' }, 404);
        }
        logRouteError('/system-bundles/objects/sha256/:sha256', err);
        return c.json({ error: 'Host bundle unavailable' }, 502);
      }
    }

    try {
      const object = await hostBundleObjectStore.getObject(
        objectKey,
        { signal: AbortSignal.timeout(HOST_BUNDLE_READ_TIMEOUT_MS) },
      );
      if (!object.body) {
        return c.json({ error: 'Not found' }, 404);
      }
      return new Response(object.body, {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'cache-control': 'public, max-age=31536000, immutable',
          'cdn-cache-control': 'public, max-age=31536000, immutable',
          'cloudflare-cdn-cache-control': 'public, max-age=31536000, immutable',
        },
      });
    } catch (err: unknown) {
      if (isObjectNotFoundError(err)) {
        return c.json({ error: 'Not found' }, 404);
      }
      logRouteError('/system-bundles/objects/sha256/:sha256 getObject', err);
      return c.json({ error: 'Host bundle unavailable' }, 502);
    }
  });

  // Public, immutable host-service bundles used by customer VPS cloud-init.
  // Metadata comes from Postgres; R2 only stores the bytes.
  routes.get('/:imageVersion/:file', async (c) => {
    const hostBundleObjectStore = getHostBundleObjectStore();
    if (!hostBundleObjectStore) {
      return c.json({ error: 'Host bundle storage unavailable' }, 503);
    }

    const imageVersion = c.req.param('imageVersion');
    const file = c.req.param('file');
    if (imageVersion === 'channels') {
      if (!HOST_BUNDLE_CHANNEL_FILE_PATTERN.test(file)) {
        return c.json({ error: 'Invalid request' }, 400);
      }
      try {
        const channel = file.slice(0, -5);
        const release = await getHostBundleReleaseByChannel(db, channel);
        if (!release) {
          return c.json({ error: 'Not found' }, 404);
        }
        const url = await getSignedBundleUrl(release);
        return c.json(hostBundleReleaseResponse(release, url, channel), 200, {
          'cache-control': 'private, max-age=30',
        });
      } catch (err: unknown) {
        logRouteError('/system-bundles/channels/:channel', err);
        return c.json({ error: 'Host bundle unavailable' }, 502);
      }
    }

    if (!HOST_BUNDLE_IMAGE_VERSION_PATTERN.test(imageVersion) || !HOST_BUNDLE_FILES.has(file)) {
      return c.json({ error: 'Invalid request' }, 400);
    }

    const isChannelAlias = HOST_BUNDLE_CHANNEL_PATTERN.test(imageVersion);
    let release: HostBundleReleaseRecord | undefined;
    try {
      release = isChannelAlias
        ? await getHostBundleReleaseByChannel(db, imageVersion)
        : await getHostBundleRelease(db, imageVersion);
    } catch (err: unknown) {
      logRouteError('/system-bundles/:imageVersion/:file db', err);
      return c.json({ error: 'Host bundle unavailable' }, 502);
    }
    if (!release) {
      return c.json({ error: 'Not found' }, 404);
    }

    if (file.endsWith('.tar.gz') && hostBundleObjectStore.getPresignedGetUrl) {
      try {
        const url = await getSignedBundleUrl(release);
        return c.redirect(url, 302);
      } catch (err: unknown) {
        if (isObjectNotFoundError(err)) {
          return c.json({ error: 'Not found' }, 404);
        }
        logRouteError('/system-bundles/:imageVersion/:file', err);
        return c.json({ error: 'Host bundle unavailable' }, 502);
      }
    }

    if (file.endsWith('.sha256')) {
      const cacheHeaders = isChannelAlias
        ? {
          'cache-control': 'private, max-age=30',
          'cdn-cache-control': 'private, max-age=30',
          'cloudflare-cdn-cache-control': 'private, max-age=30',
        }
        : {
          'cache-control': 'public, max-age=31536000, immutable',
          'cdn-cache-control': 'public, max-age=31536000, immutable',
          'cloudflare-cdn-cache-control': 'public, max-age=31536000, immutable',
        };
      return c.text(`${release.sha256}  matrix-host-bundle.tar.gz\n`, 200, {
        'content-type': 'text/plain; charset=utf-8',
        ...cacheHeaders,
      });
    }

    if (file === 'incremental-manifest.json') {
      if (!release.incrementalManifestKey) {
        return c.json({ error: 'Not found' }, 404);
      }
      if (hostBundleObjectStore.getPresignedGetUrl) {
        try {
          const url = await getSignedHostBundleObjectUrl(release.incrementalManifestKey);
          return c.redirect(url, 302);
        } catch (err: unknown) {
          if (isObjectNotFoundError(err)) {
            return c.json({ error: 'Not found' }, 404);
          }
          logRouteError('/system-bundles/:imageVersion/incremental-manifest.json', err);
          return c.json({ error: 'Host bundle unavailable' }, 502);
        }
      }
      try {
        const object = await hostBundleObjectStore.getObject(
          release.incrementalManifestKey,
          { signal: AbortSignal.timeout(HOST_BUNDLE_READ_TIMEOUT_MS) },
        );
        if (!object.body) {
          return c.json({ error: 'Not found' }, 404);
        }
        return new Response(object.body, {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'public, max-age=31536000, immutable',
            'cdn-cache-control': 'public, max-age=31536000, immutable',
            'cloudflare-cdn-cache-control': 'public, max-age=31536000, immutable',
          },
        });
      } catch (err: unknown) {
        if (isObjectNotFoundError(err)) {
          return c.json({ error: 'Not found' }, 404);
        }
        logRouteError('/system-bundles/:imageVersion/incremental-manifest.json getObject', err);
        return c.json({ error: 'Host bundle unavailable' }, 502);
      }
    }

    if (file.endsWith('.json')) {
      try {
        const url = await getSignedBundleUrl(release);
        return c.json(hostBundleReleaseResponse(release, url, isChannelAlias ? imageVersion : undefined), 200, {
          'cache-control': 'private, max-age=30',
        });
      } catch (err: unknown) {
        logRouteError('/system-bundles/:imageVersion/:file json', err);
        return c.json({ error: 'Host bundle unavailable' }, 502);
      }
    }

    try {
      const object = await hostBundleObjectStore.getObject(
        release.bundleKey,
        { signal: AbortSignal.timeout(HOST_BUNDLE_READ_TIMEOUT_MS) },
      );
      if (!object.body) {
        return c.json({ error: 'Not found' }, 404);
      }
      const headers = new Headers({
        'content-type': file.endsWith('.json')
          ? 'application/json; charset=utf-8'
          : file.endsWith('.sha256')
            ? 'text/plain; charset=utf-8'
            : 'application/gzip',
        'cache-control': 'public, max-age=31536000, immutable',
        'cdn-cache-control': 'public, max-age=31536000, immutable',
        'cloudflare-cdn-cache-control': 'public, max-age=31536000, immutable',
      });
      if (object.etag) headers.set('etag', object.etag);
      if (typeof object.contentLength === 'number') {
        headers.set('content-length', String(object.contentLength));
      }
      return new Response(object.body, { status: 200, headers });
    } catch (err: unknown) {
      if (isObjectNotFoundError(err)) {
        return c.json({ error: 'Not found' }, 404);
      }
      logRouteError('/system-bundles/:imageVersion/:file', err);
      return c.json({ error: 'Host bundle unavailable' }, 502);
    }
  });

  routes.get('/channels/:channel', async (c) => {
    const hostBundleObjectStore = getHostBundleObjectStore();
    if (!hostBundleObjectStore) {
      return c.json({ error: 'Host bundle storage unavailable' }, 503);
    }

    const channel = c.req.param('channel');
    if (!HOST_BUNDLE_CHANNEL_PATTERN.test(channel)) {
      return c.json({ error: 'Invalid request' }, 400);
    }

    try {
      const release = await getHostBundleReleaseByChannel(db, channel);
      if (!release) {
        return c.json({ error: 'Not found' }, 404);
      }
      const url = await getSignedBundleUrl(release);
      return c.json(hostBundleReleaseResponse(release, url, channel), 200, {
        'cache-control': 'private, max-age=30',
      });
    } catch (err: unknown) {
      logRouteError('/system-bundles/channels/:channel', err);
      return c.json({ error: 'Host bundle unavailable' }, 502);
    }
  });

  return routes;
}
