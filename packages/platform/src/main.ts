import { createHmac, randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serve } from '@hono/node-server';
import { installPostHogHonoErrorTracking, MATRIX_TELEMETRY_EVENTS } from '@matrix-os/observability';
import { createConnection, type Socket } from 'node:net';
import { connect as createTlsConnection } from 'node:tls';
import type { IncomingMessage, Server } from 'node:http';
import Dockerode from 'dockerode';
import { Agent } from 'undici';
import { z } from 'zod/v4';
import {
  createPlatformDb,
  type PlatformDB,
  getContainer,
  getContainerByClerkId,
  getActiveUserMachineByClerkId,
  getActiveUserMachineByHandle,
  getRunningUserMachineByClerkId,
  getRunningUserMachineByHandle,
  listActiveUserMachinesByClerkId,
  listUserMachines,
  listAllUserMachines,
  updateLastActive,
  updateContainerStatus,
  listContainers,
  getHostBundleRelease,
  getHostBundleReleaseByChannel,
  HostBundleReleaseConflictError,
  listHostBundleReleases,
  promoteHostBundleChannel,
  upsertHostBundleRelease,
  type HostBundleReleaseRecord,
  type UserMachineRecord,
} from './db.js';
import type { Orchestrator } from './orchestrator.js';
import { createSocialApi } from './social.js';
import { createStoreApi } from './store-api.js';
import { createSocialFeedApi } from './social-api.js';
import { createClerkAuth, type ClerkAuth } from './clerk-auth.js';
import type { MatrixProvisioner } from './matrix-provisioning.js';
import { createAuthRoutes } from './auth-routes.js';
import { issueSyncJwt, verifySyncJwt } from './sync-jwt.js';
import {
  getSessionRoutedWebSocketHost,
  getWebSocketUpgradeToken,
  isAppDomainHost,
  isCodeDomainHost,
  isSessionRoutedHost,
  isSafeWebSocketUpgradePath,
  stripWebSocketUpgradeToken,
} from './ws-upgrade.js';
import {
  buildPlatformVerificationToken,
  timingSafeTokenEquals,
} from './platform-token.js';
import type { CustomerVpsService } from './customer-vps.js';
import { createCustomerVpsRoutes } from './customer-vps-routes.js';
import { CustomerVpsError } from './customer-vps-errors.js';
import {
  buildCustomerVpsProxyUrl,
  deriveEntitlementAccess,
  EntitlementStatusSchema,
  type EntitlementAccessDecision,
} from './profile-routing.js';
import type { CustomerVpsObjectStore } from './customer-vps-r2.js';
import { handleInternalGeminiLiveProxyUpgrade } from './gemini-live-proxy.js';
import { recordPlatformHttpRequest } from './metrics.js';
import type { VpsRuntimeMetricInput } from './metrics.js';
import {
  createLaunchReadinessService,
  createPlatformLaunchEvidenceLoader,
} from './launch-readiness.js';
import { createLaunchReadinessRoutes } from './launch-readiness-routes.js';
import { RuntimeSlotSchema } from './customer-vps-schema.js';
import { shouldVerifyCustomerVpsTls } from './customer-vps-tls.js';

const PORT = Number(process.env.PLATFORM_PORT ?? 9000);
const PLATFORM_SECRET = process.env.PLATFORM_SECRET ?? '';
const PLATFORM_JWT_SECRET = process.env.PLATFORM_JWT_SECRET ?? '';
const DEV_PLATFORM_SECRET = 'dev-secret';
const DEV_PLATFORM_JWT_SECRET = 'dev-platform-jwt-secret-please-change-32';
const HANDLE_PATTERN = /^[a-z][a-z0-9-]{2,30}$/;
const ADMIN_BODY_LIMIT = 64 * 1024;
const PROXY_BODY_LIMIT = 10 * 1024 * 1024;
const CLERK_SCRIPT_ORIGIN = 'https://clerk.matrix-os.com';
const PROXY_TIMEOUT_MS = 30_000;
const VPS_RELEASE_PROBE_TIMEOUT_MS = 10_000;
const RUNTIME_PICKER_PROBE_TIMEOUT_MS = 2_500;
const VPS_RUNTIME_METRICS_TTL_MS = 45_000;
const DOCKER_INSPECT_TIMEOUT_MS = 10_000;
const CODE_SERVER_PORT = Number(process.env.MATRIX_CODE_SERVER_PORT ?? 8787);
const CODE_SESSION_COOKIE = 'matrix_code_session';
const APP_ROUTE_COOKIE = 'matrix_app_route';
const SHELL_ROUTE_COOKIE = 'matrix_shell_route';
const CODE_SESSION_EXPIRES_IN_SEC = 12 * 60 * 60;
const HOST_BUNDLE_READ_TIMEOUT_MS = 30_000;
const HOST_BUNDLE_IMAGE_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const HOST_BUNDLE_FILES = new Set([
  'matrix-host-bundle.tar.gz',
  'matrix-host-bundle.tar.gz.sha256',
  'manifest.json',
  'release.json',
]);
const HOST_BUNDLE_CHANNEL_PATTERN = /^(stable|canary|dev|beta)$/;
const HOST_BUNDLE_CHANNEL_FILE_PATTERN = /^(stable|canary|dev|beta)\.json$/;
const TENANT_PUBLIC_TELEMETRY_ENV_KEYS = [
  'POSTHOG_TOKEN',
  'POSTHOG_PROJECT_TOKEN',
  'POSTHOG_HOST',
  'NEXT_PUBLIC_POSTHOG_KEY',
  'NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN',
  'NEXT_PUBLIC_POSTHOG_HOST',
  'NEXT_PUBLIC_POSTHOG_API_HOST',
] as const;

// User containers churn frequently, so keep proxy connections short-lived
// instead of letting long-lived pooled upstream state go stale.
const containerProxyDispatcher = new Agent({
  pipelining: 0,
  keepAliveTimeout: 1,
  keepAliveMaxTimeout: 1,
  connections: 64,
});

const customerVpsProxyDispatcher = new Agent({
  pipelining: 0,
  keepAliveTimeout: 1,
  keepAliveMaxTimeout: 1,
  connections: 64,
  connect: {
    rejectUnauthorized: shouldVerifyCustomerVpsTls(),
  },
});
const WS_TOKEN_EXPIRES_IN_SEC = 5 * 60;
const SENSITIVE_PROXY_HEADERS = new Set(['authorization', 'cookie']);
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);
const DECODED_FETCH_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
]);

const HostBundleReleaseBodySchema = z.object({
  version: z.string().regex(HOST_BUNDLE_IMAGE_VERSION_PATTERN),
  gitCommit: z.string().min(7).max(64),
  gitRef: z.string().max(256).nullable().optional(),
  buildTime: z.string().min(1).max(128),
  bundleKey: z.string().regex(/^system-bundles\/[A-Za-z0-9._-]{1,128}\/matrix-host-bundle\.tar\.gz$/),
  checksumKey: z.string().regex(/^system-bundles\/[A-Za-z0-9._-]{1,128}\/matrix-host-bundle\.tar\.gz\.sha256$/).nullable().optional(),
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

function sanitizeProxyResponseHeaders(headers: Headers): Headers {
  const sanitized = new Headers(headers);
  for (const header of HOP_BY_HOP_RESPONSE_HEADERS) {
    sanitized.delete(header);
  }
  for (const header of DECODED_FETCH_RESPONSE_HEADERS) {
    sanitized.delete(header);
  }
  return sanitized;
}

function collectTenantPublicTelemetryEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return TENANT_PUBLIC_TELEMETRY_ENV_KEYS
    .map((key) => {
      const value = env[key];
      if (!value) return null;
      if (/[\r\n\0]/.test(value)) {
        throw new Error(`Invalid public telemetry env value for ${key}`);
      }
      return `${key}=${value}`;
    })
    .filter((value): value is string => value !== null);
}

const ProvisionBodySchema = z.object({
  handle: z.string().regex(HANDLE_PATTERN),
  clerkUserId: z.string().min(1).max(256),
  displayName: z.string().min(1).max(100).optional(),
  runtimeSlot: RuntimeSlotSchema.optional().default('primary'),
});

const SocialSendBodySchema = z.object({
  text: z.string().min(1).max(10_000),
  from: z.object({
    handle: z.string().regex(HANDLE_PATTERN),
    displayName: z.string().min(1).max(100).optional(),
  }),
});

interface GatewayPlatformUser {
  id: string;
}

interface GatewayPlatformDb {
  migrate(): Promise<void>;
  getUserByClerkId(clerkId: string): Promise<GatewayPlatformUser | null>;
  ensureUser(input: {
    clerkId: string;
    handle: string;
    displayName: string;
    email: string;
    containerId: string;
    containerVersion?: string;
    plan?: string;
    pipedreamExternalId?: string;
  }): Promise<GatewayPlatformUser>;
}

interface GatewayPlatformDbModule {
  createPlatformDb(databaseUrl: string): GatewayPlatformDb;
}

interface GatewayPipedreamConfig {
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment?: string;
}

interface GatewayPipedreamModule {
  createPipedreamClient(config: GatewayPipedreamConfig): unknown;
}

interface GatewayIntegrationRoutesModule {
  createIntegrationRoutes(opts: {
    db: GatewayPlatformDb;
    pipedream: unknown;
    webhookSecret: string;
    resolveUserId: (c: Context) => Promise<string | null>;
  }): Hono;
}

interface GatewayR2Client {
  getPresignedGetUrl(key: string, expiresIn?: number): Promise<string>;
  getPresignedPutUrl(key: string, size: number, expiresIn?: number): Promise<string>;
  createMultipartUpload(key: string): Promise<string>;
  getPresignedPartUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn?: number,
  ): Promise<string>;
  getObject(
    key: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ body: ReadableStream | null; etag?: string; contentLength?: number }>;
  putObject(
    key: string,
    body: string | Uint8Array | ReadableStream<Uint8Array>,
    options?: { signal?: AbortSignal },
  ): Promise<{ etag?: string }>;
  deleteObject(key: string): Promise<void>;
  destroy(): void;
}

interface GatewayR2ClientModule {
  createR2Client(config: {
    accountId?: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    endpoint?: string;
    publicEndpoint?: string;
    forcePathStyle?: boolean;
  }): GatewayR2Client;
}

async function importRuntimeModule<T>(specifier: string): Promise<T> {
  return import(specifier) as Promise<T>;
}

function isMissingContainerError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('No container for handle:');
}

function logPlatformRouteError(route: string, err: unknown): void {
  console.error(
    `[platform] ${route} failed:`,
    err instanceof Error ? err.message : String(err),
  );
}

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

function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${escapedName}=([^;]+)`));
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch (err: unknown) {
    if (err instanceof URIError) {
      return null;
    }
    console.warn('[platform] Failed to decode cookie value:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

function readMobileAppSessionRoutingHandle(path: string, rawUrl: string): string | null {
  if (!(path === '/apps' || path.startsWith('/apps/'))) {
    return null;
  }
  let token: string | null = null;
  try {
    token = new URL(rawUrl).searchParams.get('session');
  } catch (err: unknown) {
    if (!(err instanceof TypeError)) {
      console.warn('[platform] Failed to parse app session URL:', err instanceof Error ? err.message : String(err));
    }
    return null;
  }
  if (!token) return null;
  const separator = token.indexOf('.');
  if (separator <= 0) return null;
  const handle = token.slice(0, separator);
  return HANDLE_PATTERN.test(handle) ? handle : null;
}

function readMobileAppRouteCookie(path: string, cookieHeader: string | undefined): string | null {
  if (!(path === '/apps' || path.startsWith('/apps/'))) {
    return null;
  }
  const handle = readCookie(cookieHeader, APP_ROUTE_COOKIE);
  return handle && HANDLE_PATTERN.test(handle) ? handle : null;
}

function getAppRouteCookiePath(path: string): string | null {
  const match = path.match(/^\/apps\/([^/?#]+)/);
  if (!match?.[1]) return null;
  return `/apps/${match[1]}/`;
}

function buildAppRouteCookie(handle: string, path: string): string | null {
  const cookiePath = getAppRouteCookiePath(path);
  if (!cookiePath) return null;
  return [
    `${APP_ROUTE_COOKIE}=${encodeURIComponent(handle)}`,
    `Path=${cookiePath}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=600',
  ].join('; ');
}

function readShellRouteCookie(path: string, cookieHeader: string | undefined): string | null {
  if (!isAppDomainStaticAssetPath(path)) {
    return null;
  }
  const handle = readCookie(cookieHeader, SHELL_ROUTE_COOKIE);
  return handle && HANDLE_PATTERN.test(handle) ? handle : null;
}

function buildShellRouteCookie(handle: string): string {
  return [
    `${SHELL_ROUTE_COOKIE}=${encodeURIComponent(handle)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=600',
  ].join('; ');
}

type RuntimeSlotSource = 'query' | 'default';

interface RuntimeSlotSelection {
  slot: string;
  source: RuntimeSlotSource;
}

function readRuntimeSlotSelection(rawUrl: string): RuntimeSlotSelection {
  try {
    const querySlot = new URL(rawUrl, 'https://app.matrix-os.com').searchParams.get('runtime');
    if (querySlot && RuntimeSlotSchema.safeParse(querySlot).success) {
      return { slot: querySlot, source: 'query' };
    }
  } catch (err: unknown) {
    console.warn('[platform] Failed to parse runtime slot URL:', err instanceof Error ? err.message : String(err));
  }
  return { slot: 'primary', source: 'default' };
}

function readRuntimeSlot(rawUrl: string): string {
  return readRuntimeSlotSelection(rawUrl).slot;
}

function buildForwardedQueryString(rawUrl: string): string {
  const queryStart = rawUrl.indexOf('?');
  if (queryStart === -1) return '';
  // Browser HTTP requests do not include fragments, but synthetic proxy tests
  // may pass raw URLs with hashes; never forward fragment text as query data.
  const hashStart = rawUrl.indexOf('#', queryStart);
  const rawQuery = rawUrl.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart);
  const forwarded = rawQuery
    .split('&')
    .filter((part) => {
      if (!part) return false;
      const rawKey = part.split('=', 1)[0] ?? '';
      // Decode the key before filtering so encoded variants such as
      // `%72untime=staging` cannot leak the platform-only runtime selector to
      // a customer VPS.
      const parsedKey = new URLSearchParams(`${rawKey}=`).keys().next().value ?? rawKey;
      return parsedKey !== 'runtime';
    })
    .join('&');
  return forwarded ? `?${forwarded}` : '';
}

export function buildPostAuthRedirectPath(rawUrl: string): string {
  try {
    const url = new URL(rawUrl, 'https://app.matrix-os.com');
    const normalizedPath = url.pathname.replace(/^\/{2,}/, '/');
    const path = /^\/sign-(?:in|up)\/?$/.test(normalizedPath) ? '/' : normalizedPath;
    const runtime = url.searchParams.get('runtime');
    if (runtime && RuntimeSlotSchema.safeParse(runtime).success) {
      return `${path}?runtime=${encodeURIComponent(runtime)}`;
    }
    return path;
  } catch (err: unknown) {
    console.warn('[platform] Failed to build post-auth redirect:', err instanceof Error ? err.message : String(err));
    return '/';
  }
}

function isAppDomainGatewayPath(path: string): boolean {
  return (
    path.startsWith('/api/') ||
    path.startsWith('/ws') ||
    path.startsWith('/files/') ||
    path.startsWith('/modules/') ||
    path === '/health'
  );
}

interface ExplicitVmRoute {
  handle: string;
  upstreamPath: string;
}

function readExplicitVmRoute(path: string): ExplicitVmRoute | null {
  const match = path.match(/^\/vm\/([a-z][a-z0-9-]{2,30})(?:\/(.*))?$/);
  if (!match?.[1]) return null;
  const rest = match[2];
  return {
    handle: match[1],
    upstreamPath: rest ? `/${rest}` : '/',
  };
}

function readGatewayRouteCookie(path: string, cookieHeader: string | undefined): string | null {
  if (!isAppDomainGatewayPath(path)) return null;
  const handle = readCookie(cookieHeader, SHELL_ROUTE_COOKIE);
  return handle && HANDLE_PATTERN.test(handle) ? handle : null;
}

function readAppDomainRouteCookie(path: string, cookieHeader: string | undefined): string | null {
  return readGatewayRouteCookie(path, cookieHeader) ?? readShellRouteCookie(path, cookieHeader);
}

function getRuntimeEntitlementDecision(env: NodeJS.ProcessEnv = process.env): EntitlementAccessDecision {
  const rawStatus = env.MATRIX_PAID_BETA_ENTITLEMENT_STATUS?.trim();
  if (!rawStatus) {
    return deriveEntitlementAccess({ status: 'active' });
  }
  const parsed = EntitlementStatusSchema.safeParse(rawStatus);
  if (!parsed.success) {
    console.warn('[platform] Invalid MATRIX_PAID_BETA_ENTITLEMENT_STATUS; denying paid runtime access.');
    return deriveEntitlementAccess({ status: 'changed' });
  }
  return deriveEntitlementAccess({ status: parsed.data });
}

function buildCodeSessionCookie(token: string): string {
  return [
    `${CODE_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${CODE_SESSION_EXPIRES_IN_SEC}`,
  ].join('; ');
}

function applyNoStoreHeaders(c: import('hono').Context): void {
  c.header('Cache-Control', 'no-store, private');
  c.header('CDN-Cache-Control', 'no-store');
  c.header('Cloudflare-CDN-Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  c.header('Expires', '0');
}

function applyCookieRoutedShellAssetCacheHeaders(headers: Headers): void {
  headers.set('cache-control', 'private, no-store');
  headers.set('cdn-cache-control', 'no-store');
  headers.set('cloudflare-cdn-cache-control', 'no-store');
  const vary = headers.get('vary');
  const varyParts = new Set(
    (vary ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  );
  varyParts.add('Cookie');
  varyParts.add('Accept-Encoding');
  headers.set('vary', Array.from(varyParts).join(', '));
}

function isCodeDomainStaticAssetPath(path: string): boolean {
  return (
    path === '/favicon.ico' ||
    path.startsWith('/_static/') ||
    /^\/stable-[^/]+\/static\//.test(path)
  );
}

function isAppDomainStaticAssetPath(path: string): boolean {
  return (
    path === '/favicon.ico' ||
    path === '/icon.png' ||
    path === '/manifest.json' ||
    path === '/og.png' ||
    path.startsWith('/_next/static/') ||
    path.startsWith('/_next/image')
  );
}

function buildCodeDomainProxyHeaders(
  requestHeaders: Record<string, string | undefined>,
  host: string,
  codeProxyToken?: string,
): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(requestHeaders)) {
    if (key !== 'host' && key !== 'cookie' && key !== 'authorization' && key !== 'x-matrix-code-proxy-token' && value) {
      headers.set(key, value);
    }
  }
  if (codeProxyToken) {
    headers.set('x-matrix-code-proxy-token', codeProxyToken);
  }
  headers.set('host', host);
  headers.set('x-forwarded-host', host);
  headers.set('x-forwarded-proto', 'https');
  headers.set('connection', 'close');
  return headers;
}

function buildPlatformUserProof(handle: string, userId: string, platformSecret: string): string {
  const handleToken = buildPlatformVerificationToken(handle, platformSecret);
  return createHmac('sha256', handleToken).update(userId).digest('hex');
}

export function classifyWebSocketPath(path: string): string {
  try {
    const parsed = new URL(path, 'https://app.matrix-os.com');
    if (parsed.pathname.startsWith('/ws/terminal')) return '/ws/terminal';
    if (parsed.pathname === '/ws') return '/ws';
    if (parsed.pathname.startsWith('/ws/')) return '/ws/*';
    return 'other';
  } catch (err: unknown) {
    if (err instanceof TypeError) return 'invalid';
    throw err;
  }
}

export function classifySessionRoutedHost(host: string): 'app' | 'code' | 'other' {
  if (isAppDomainHost(host)) return 'app';
  if (isCodeDomainHost(host)) return 'code';
  return 'other';
}

export function buildPlatformWebSocketUpgradeHeaders(opts: {
  incomingHeaders: IncomingMessage['headers'];
  externalHost: string;
  handle: string;
  userId: string;
  platformSecret: string;
  includePlatformProof: boolean;
  isCodeDomain: boolean;
}): string {
  return Object.entries(opts.incomingHeaders)
    .filter(([k]) => (
      k !== 'host' &&
      k !== 'authorization' &&
      k !== 'cookie' &&
      k !== 'x-forwarded-host' &&
      k !== 'x-forwarded-proto'
    ))
    .flatMap(([k, v]) => {
      if (v === undefined) return [];
      return `${k}: ${Array.isArray(v) ? v.join(', ') : v}`;
    })
    .concat([
      `x-forwarded-host: ${opts.externalHost}`,
      'x-forwarded-proto: https',
    ])
    .concat(
      opts.platformSecret && opts.includePlatformProof
        ? [
            `authorization: Bearer ${buildPlatformVerificationToken(opts.handle, opts.platformSecret)}`,
            `x-platform-verified: ${buildPlatformUserProof(opts.handle, opts.userId, opts.platformSecret)}`,
            `x-platform-user-id: ${opts.userId}`,
          ]
        : [],
    )
    .concat(
      opts.platformSecret && opts.isCodeDomain
        ? [`x-matrix-code-proxy-token: ${buildPlatformVerificationToken(opts.handle, opts.platformSecret)}`]
        : [],
    )
    .join('\r\n');
}

function requireValidHandle(handle: string): string {
  if (!HANDLE_PATTERN.test(handle)) {
    throw new Error('Invalid handle');
  }
  return handle;
}

function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&#39;");
}

function escapeHtml(value: string): string {
  return escapeHtmlAttr(value);
}

function applyAuthPageHeaders(
  c: import('hono').Context,
  scriptNonce: string,
): void {
  applyNoStoreHeaders(c);
  c.header('X-Frame-Options', 'DENY');
  c.header(
    'Content-Security-Policy',
    `frame-ancestors 'none'; script-src 'self' 'nonce-${scriptNonce}' ${CLERK_SCRIPT_ORIGIN}; object-src 'none'; base-uri 'none'`,
  );
}

export function checkUnsafeDefaultSecrets(
  env: NodeJS.ProcessEnv = process.env,
  log: (msg: string) => void = console.error,
): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const problems: string[] = [];

  if (!env.PLATFORM_SECRET || env.PLATFORM_SECRET === DEV_PLATFORM_SECRET) {
    problems.push('PLATFORM_SECRET');
  }

  if (
    !env.PLATFORM_JWT_SECRET ||
    env.PLATFORM_JWT_SECRET === DEV_PLATFORM_JWT_SECRET
  ) {
    problems.push('PLATFORM_JWT_SECRET');
  }

  if (problems.length > 0) {
    log(
      `[platform] Refusing to start in production with missing or unsafe default secrets: ${problems.join(', ')}.`,
    );
  }

  return problems;
}

interface AppDomainIdentity {
  handle: string;
  userId: string;
  runtimeSlot?: string;
  source?: 'auth' | 'mobile-session' | 'static-route';
}

interface ResolvedContainerEndpoint {
  containerId: string | null;
  host: string;
  source: 'record' | 'docker-id' | 'docker-name';
}

function isDockerNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('No such container') || message.includes('404');
}

async function inspectLiveContainer(
  docker: Dockerode,
  handle: string,
  containerId?: string | null,
): Promise<{ info: Dockerode.ContainerInspectInfo; source: 'docker-id' | 'docker-name' } | null> {
  const candidates: Array<{ target: string; source: 'docker-id' | 'docker-name' }> = [];
  if (containerId) {
    candidates.push({ target: containerId, source: 'docker-id' });
  }
  candidates.push({ target: `matrixos-${handle}`, source: 'docker-name' });

  for (const candidate of candidates) {
    try {
      const info = await Promise.race([
        docker.getContainer(candidate.target).inspect(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`Docker inspect timeout after ${DOCKER_INSPECT_TIMEOUT_MS}ms`)), DOCKER_INSPECT_TIMEOUT_MS);
        }),
      ]);
      return { info, source: candidate.source };
    } catch (err: unknown) {
      if (!isDockerNotFoundError(err)) {
        throw err;
      }
    }
  }

  return null;
}

function getContainerHostFromInspect(
  info: Dockerode.ContainerInspectInfo,
  handle: string,
): string {
  const networks = info.NetworkSettings?.Networks
    ? Object.values(info.NetworkSettings.Networks)
    : [];
  const ip = networks.find(
    (network) => typeof network?.IPAddress === 'string' && network.IPAddress.length > 0,
  )?.IPAddress;
  return ip || `matrixos-${handle}`;
}

async function resolveContainerEndpoint(
  docker: Dockerode | undefined,
  db: PlatformDB,
  handle: string,
  containerId?: string | null,
): Promise<ResolvedContainerEndpoint | null> {
  if (!docker) {
    return {
      containerId: containerId ?? null,
      host: `matrixos-${handle}`,
      source: 'record',
    };
  }

  const inspected = await inspectLiveContainer(docker, handle, containerId);
  if (!inspected) {
    return null;
  }

  const { info, source } = inspected;
  if (info.Id && info.Id !== containerId) {
    await updateContainerStatus(db, handle, info.State?.Running ? 'running' : 'stopped', info.Id);
  }

  return {
    containerId: info.Id ?? containerId ?? null,
    host: getContainerHostFromInspect(info, handle),
    source,
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as Error & { code?: string }).code;
    return code ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}
function isSyncJwtAuthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const errorWithCode = err as Error & { code?: unknown };
  const errorCode = typeof errorWithCode.code === 'string'
    ? errorWithCode.code
    : '';
  return (
    err.name.startsWith("JWT") ||
    err.name.startsWith("JWS") ||
    err.name.startsWith("JOSE") ||
    errorCode.startsWith("ERR_JOSE_") ||
    err.message === "Invalid sync JWT claims" ||
    err.message.startsWith("JWT handle ")
  );
}

async function resolveAppDomainIdentity(opts: {
  authHeader: string | undefined;
  cookieHeader: string | undefined;
  clerkAuth?: ClerkAuth;
  db: PlatformDB;
  platformJwtSecret: string;
  allowUnroutedClerkIdentity?: boolean;
  requestedHandle?: string | null;
  runtimeSlot: string;
  wsToken?: string | null;
}): Promise<AppDomainIdentity | null> {
  const codeSessionToken = readCookie(opts.cookieHeader, CODE_SESSION_COOKIE);
  const bearerToken =
    opts.authHeader?.startsWith('Bearer ')
      ? opts.authHeader.slice(7)
      : opts.wsToken ?? codeSessionToken;

  if (bearerToken && opts.platformJwtSecret) {
    try {
      const claims = await verifySyncJwt(bearerToken, { secret: opts.platformJwtSecret });
      const record = await getContainer(opts.db, claims.handle);
      if (record?.clerkUserId === claims.sub) {
        return {
          handle: record.handle,
          userId: record.clerkUserId,
        };
      }
      const runtimeSlot = RuntimeSlotSchema.safeParse(claims.runtime_slot).success
        ? claims.runtime_slot
        : undefined;
      const machine = await getRunningUserMachineByHandle(opts.db, claims.handle, runtimeSlot);
      if (machine?.clerkUserId === claims.sub) {
        return {
          handle: machine.handle,
          userId: machine.clerkUserId,
          runtimeSlot: machine.runtimeSlot,
        };
      }
      const activeMachine = await getActiveUserMachineByHandle(opts.db, claims.handle, runtimeSlot);
      if (!activeMachine || activeMachine.clerkUserId !== claims.sub) {
        return null;
      }
      return {
        handle: activeMachine.handle,
        userId: activeMachine.clerkUserId,
        runtimeSlot: activeMachine.runtimeSlot,
      };
    } catch (err: unknown) {
      if (!isSyncJwtAuthError(err)) {
        throw err;
      }
      // Fall through to Clerk session auth.
    }
  }

  if (!opts.clerkAuth) {
    return null;
  }

  const token = opts.clerkAuth.extractToken(opts.authHeader, opts.cookieHeader);
  if (!token) {
    return null;
  }

  const result = await opts.clerkAuth.verify(token);
  if (!result.authenticated || !result.userId) {
    return null;
  }

  if (opts.requestedHandle) {
    const requestedMachine = await getActiveUserMachineByHandle(opts.db, opts.requestedHandle);
    if (requestedMachine && requestedMachine.clerkUserId === result.userId) {
      return {
        handle: requestedMachine.handle,
        userId: result.userId,
        runtimeSlot: requestedMachine.runtimeSlot,
      };
    }
  }

  const record = await getContainerByClerkId(opts.db, result.userId);
  if (record) {
    return {
      handle: record.handle,
      userId: result.userId,
    };
  }
  let machine = opts.runtimeSlot !== 'primary'
    ? await getActiveUserMachineByClerkId(opts.db, result.userId, opts.runtimeSlot)
    : undefined;
  if (!machine) {
    machine = await getActiveUserMachineByClerkId(opts.db, result.userId);
  }
  if (!machine) {
    if (opts.allowUnroutedClerkIdentity) {
      return {
        handle: '',
        userId: result.userId,
      };
    }
    return null;
  }

  return {
    handle: machine.handle,
    userId: result.userId,
    runtimeSlot: machine.runtimeSlot,
  };
}

async function probeCustomerVpsRelease(machine: UserMachineRecord, platformSecret: string, options: {
  timeoutMs?: number;
} = {}): Promise<{
  reachable: boolean;
  statusCode?: number;
  release?: unknown;
  startedAt?: string;
  error?: string;
}> {
  const targetUrl = buildCustomerVpsProxyUrl(machine, '/api/system/info');
  if (!targetUrl) {
    return { reachable: false, error: 'VPS unreachable' };
  }
  if (!platformSecret) {
    return { reachable: false, error: 'Platform auth unavailable' };
  }
  const headers = new Headers({
    authorization: `Bearer ${buildPlatformVerificationToken(machine.handle, platformSecret)}`,
    host: 'app.matrix-os.com',
    'x-forwarded-host': 'app.matrix-os.com',
    'x-forwarded-proto': 'https',
    connection: 'close',
  });
  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? VPS_RELEASE_PROBE_TIMEOUT_MS),
      dispatcher: customerVpsProxyDispatcher,
    } as RequestInit & { dispatcher: Agent });
    if (!response.ok) {
      return { reachable: false, statusCode: response.status, error: 'System info unavailable' };
    }
    const info = await response.json() as { release?: unknown; startedAt?: string };
    return {
      reachable: true,
      statusCode: response.status,
      release: info.release,
      startedAt: info.startedAt,
    };
  } catch (err: unknown) {
    console.warn(
      `[platform] VPS release probe failed handle=${machine.handle} machine=${machine.machineId} error=${describeError(err)}`,
    );
    return { reachable: false, error: 'VPS release probe failed' };
  }
}

async function probeCustomerVpsRuntime(
  machine: { handle: string; publicIPv4: string | null },
  platformSecret: string,
): Promise<{
  healthy: boolean;
  runtimeVersion?: string | null;
  probeLatencyMs?: number;
  load1?: number | null;
  cpuCount?: number | null;
  memoryTotalBytes?: number | null;
  memoryFreeBytes?: number | null;
  diskTotalBytes?: number | null;
  diskFreeBytes?: number | null;
}> {
  if (!machine.publicIPv4) return { healthy: false };
  if (!platformSecret) return { healthy: false };
  const token = buildPlatformVerificationToken(machine.handle, platformSecret);
  const started = performance.now();
  try {
    const res = await fetch(`https://${machine.publicIPv4}:443/api/system/info`, {
      headers: {
        authorization: `Bearer ${token}`,
        host: 'app.matrix-os.com',
        'x-forwarded-host': 'app.matrix-os.com',
        'x-forwarded-proto': 'https',
      },
      dispatcher: customerVpsProxyDispatcher,
      signal: AbortSignal.timeout(8_000),
    } as RequestInit & { dispatcher: Agent });
    const probeLatencyMs = performance.now() - started;
    if (!res.ok) return { healthy: false, probeLatencyMs };

    const info = await res.json() as {
      release?: {
        version?: unknown;
      };
      resources?: {
        cpuCount?: number;
        loadAverage?: unknown;
        memoryTotalBytes?: number;
        memoryFreeBytes?: number;
        diskTotalBytes?: number | null;
        diskFreeBytes?: number | null;
      };
    };
    const loadAverage = Array.isArray(info.resources?.loadAverage) ? info.resources.loadAverage : [];
    const load1 = typeof loadAverage[0] === 'number' ? loadAverage[0] : null;
    return {
      healthy: true,
      runtimeVersion: typeof info.release?.version === 'string' ? info.release.version : null,
      probeLatencyMs,
      load1,
      cpuCount: typeof info.resources?.cpuCount === 'number' ? info.resources.cpuCount : null,
      memoryTotalBytes: typeof info.resources?.memoryTotalBytes === 'number' ? info.resources.memoryTotalBytes : null,
      memoryFreeBytes: typeof info.resources?.memoryFreeBytes === 'number' ? info.resources.memoryFreeBytes : null,
      diskTotalBytes: typeof info.resources?.diskTotalBytes === 'number' ? info.resources.diskTotalBytes : null,
      diskFreeBytes: typeof info.resources?.diskFreeBytes === 'number' ? info.resources.diskFreeBytes : null,
    };
  } catch (err: unknown) {
    console.warn(`[fleet-probe] system info failed for ${machine.handle}:`, err instanceof Error ? err.message : String(err));
    return { healthy: false, probeLatencyMs: performance.now() - started };
  }
}

function getGatewayUrlForHandle(handle: string): string {
  const safeHandle = requireValidHandle(handle);
  const tmpl = process.env.GATEWAY_URL_TEMPLATE;
  if (tmpl) {
    return tmpl.replace('{handle}', safeHandle);
  }
  return 'https://app.matrix-os.com';
}

export function escapeInlineScriptJson(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function getAuthPage(
  publishableKey: string,
  mode: 'sign-in' | 'sign-up',
  scriptNonce: string,
  redirectTarget: string,
) {
  const escapedPublishableKey = escapeHtmlAttr(publishableKey);
  const redirectTargetJson = escapeInlineScriptJson(redirectTarget);
  const modeLabel = mode === 'sign-up' ? 'Create your free Matrix account' : 'Welcome back to Matrix';
  const modeDetail = mode === 'sign-up'
    ? 'Start with a free account. The 3-day hosted Matrix trial begins only when you provision your cloud computer.'
    : 'Sign in to continue to your Matrix computer, provisioning status, or trial checkout.';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Matrix OS</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh;
      background: #E2E2CF;
      color: #32352E;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .page {
      min-height: 100vh;
      display: grid;
      grid-template-columns: minmax(0, 1.05fr) minmax(420px, 0.95fr);
    }
    .story {
      position: relative;
      display: flex;
      align-items: center;
      overflow: hidden;
      border-right: 1px solid #D6D3C8;
      background: #E0E1CA;
      padding: 64px;
    }
    .story::before {
      content: "";
      position: absolute;
      inset: 0;
      background:
        radial-gradient(ellipse at 24% 20%, rgba(250,250,245,0.78) 0%, transparent 55%),
        radial-gradient(ellipse at 82% 72%, rgba(208,111,37,0.12) 0%, transparent 60%);
    }
    .story::after {
      content: "";
      position: absolute;
      inset: 0;
      opacity: 0.08;
      background-image:
        linear-gradient(rgba(67,78,63,0.28) 1px, transparent 1px),
        linear-gradient(90deg, rgba(67,78,63,0.28) 1px, transparent 1px);
      background-size: 42px 42px;
    }
    .story-inner { position: relative; z-index: 1; max-width: 560px; }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 48px;
      color: #434E3F;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }
    .logo {
      width: 34px;
      height: 34px;
      display: grid;
      place-items: center;
      border-radius: 12px;
      background: rgba(250,250,245,0.58);
      border: 1px solid rgba(67,78,63,0.14);
      color: #D06F25;
    }
    .eyebrow {
      margin-bottom: 18px;
      color: #7A7768;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.28em;
      text-transform: uppercase;
    }
    h1 {
      max-width: 560px;
      color: #434E3F;
      font-size: clamp(2.4rem, 6vw, 4.8rem);
      line-height: 0.98;
      letter-spacing: -0.04em;
      font-weight: 750;
      margin-bottom: 24px;
    }
    .lead {
      max-width: 500px;
      color: #5C5A4F;
      font-size: 16px;
      line-height: 1.8;
    }
    .proof {
      display: grid;
      gap: 12px;
      margin-top: 38px;
    }
    .proof-row {
      display: flex;
      gap: 12px;
      align-items: flex-start;
      color: #5C5A4F;
      font-size: 13px;
      line-height: 1.55;
    }
    .dot {
      width: 9px;
      height: 9px;
      margin-top: 5px;
      border-radius: 999px;
      background: #D06F25;
      box-shadow: 0 0 0 5px rgba(208,111,37,0.12);
      flex: none;
    }
    .auth-panel {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 48px;
    }
    .auth-card {
      width: 100%;
      max-width: 390px;
      min-height: 470px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid #D6D3C8;
      border-radius: 24px;
      background: rgba(250,250,245,0.68);
      box-shadow: 0 24px 80px rgba(50,53,46,0.12);
      padding: 32px;
      backdrop-filter: blur(14px);
    }
    #auth { width: 100%; min-height: 400px; display: flex; align-items: center; justify-content: center; }
    .loading { color: #7A7768; font-size: 14px; }
    @media (max-width: 860px) {
      .page { grid-template-columns: 1fr; }
      .story { min-height: 42vh; border-right: 0; border-bottom: 1px solid #D6D3C8; padding: 40px 24px; }
      .auth-panel { padding: 28px 20px 44px; }
      .auth-card { max-width: 440px; padding: 24px; }
    }
  </style>
</head>
<body>
  <main class="page">
    <section class="story">
      <div class="story-inner">
        <div class="brand"><span class="logo">M</span><span>Matrix OS</span></div>
        <p class="eyebrow">${mode === 'sign-up' ? 'Free account' : 'Secure access'}</p>
        <h1>${modeLabel}</h1>
        <p class="lead">${modeDetail}</p>
        <div class="proof">
          <div class="proof-row"><span class="dot"></span><span>Signup stays free until you deliberately start hosted provisioning.</span></div>
          <div class="proof-row"><span class="dot"></span><span>The trial provisions an owner-controlled Matrix computer, not just a dashboard.</span></div>
          <div class="proof-row"><span class="dot"></span><span>Clerk handles account security and the payment step for the hosted runtime.</span></div>
        </div>
      </div>
    </section>
    <section class="auth-panel">
      <div class="auth-card">
        <div id="auth"><span class="loading">Loading...</span></div>
      </div>
    </section>
  </main>
  <script
    id="clerk-script"
    nonce="${scriptNonce}"
    async
    crossorigin="anonymous"
    data-clerk-publishable-key="${escapedPublishableKey}"
    src="${CLERK_SCRIPT_ORIGIN}/npm/@clerk/clerk-js@5/dist/clerk.browser.js"
    type="text/javascript"
  ></script>
  <script nonce="${scriptNonce}">
    var redirectTarget = ${redirectTargetJson};
    var appearance = {
      variables: {
        colorPrimary: '#D06F25',
        colorBackground: 'transparent',
        colorText: '#32352E',
        colorTextSecondary: '#5C5A4F',
        colorInputBackground: 'rgba(250,250,245,0.74)',
        colorInputText: '#32352E',
        borderRadius: '0.875rem',
        fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      },
      layout: {
        socialButtonsPlacement: 'top',
        socialButtonsVariant: 'blockButton',
        logoLinkUrl: 'https://matrix-os.com'
      },
      elements: {
        card: 'border-0 bg-transparent shadow-none p-0',
        header: 'text-left',
        formButtonPrimary: 'shadow-none',
        footerActionLink: 'font-medium'
      }
    };
    function initClerk() {
      window.Clerk.load({ signInUrl: '/sign-in', signUpUrl: '/sign-up' }).then(function() {
        if (window.Clerk.user) {
          window.location.replace(redirectTarget);
          return;
        }
        var el = document.getElementById('auth');
        el.innerHTML = '';
        if ('${mode}' === 'sign-up') {
          window.Clerk.mountSignUp(el, { signInUrl: '/sign-in', afterSignUpUrl: redirectTarget, appearance: appearance });
        } else {
          window.Clerk.mountSignIn(el, { signUpUrl: '/sign-up', afterSignInUrl: redirectTarget, appearance: appearance });
        }
      });
    }
    if (window.Clerk) {
      initClerk();
    } else {
      document.getElementById('clerk-script').addEventListener('load', initClerk);
    }
  </script>
</body>
</html>`;
}

function getNoContainerPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Matrix OS</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #0a0a0a; color: #fff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .card { text-align: center; max-width: 400px; padding: 2rem; }
    h1 { font-size: 1.5rem; margin-bottom: 1rem; }
    p { color: #999; margin-bottom: 1.5rem; line-height: 1.6; }
    a { color: #3b82f6; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <h1>No instance yet</h1>
    <p>Your account doesn't have a Matrix OS instance provisioned. Visit the <a href="https://matrix-os.com/dashboard">dashboard</a> to set one up.</p>
  </div>
</body>
</html>`;
}

function getVpsBootPage(input: { status: string }) {
  const title = input.status === 'recovering' ? 'Restoring Matrix OS' : 'Booting Matrix OS';
  const detail = input.status === 'recovering'
    ? 'Matrix is restoring your workspace and will bring you back automatically.'
    : 'Matrix is preparing your cloud computer. This usually takes a couple of minutes.';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="8">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at 50% 42%, rgba(196, 162, 101, 0.14), transparent 31%),
        linear-gradient(180deg, #fffdf6 0%, #f5efe2 100%);
      color: #2f392c;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      padding: 28px;
    }
    main {
      width: min(620px, 100%);
      display: grid;
      justify-items: center;
      gap: 28px;
      text-align: center;
    }
    .mark {
      width: 132px;
      height: 132px;
      border-radius: 50%;
      border: 1px solid rgba(47, 57, 44, 0.12);
      display: grid;
      place-items: center;
      background: rgba(255, 253, 246, 0.62);
      box-shadow: 0 24px 90px rgba(47, 57, 44, 0.12);
      position: relative;
      overflow: hidden;
    }
    .mark::before {
      content: "";
      width: 68px;
      height: 68px;
      border-radius: 50%;
      border: 2px solid rgba(196, 162, 101, 0.38);
      border-top-color: #c4a265;
      animation: spin 1.9s cubic-bezier(0.16, 1, 0.3, 1) infinite;
    }
    .mark::after {
      content: "M";
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      font-size: 30px;
      font-weight: 700;
      color: #2f392c;
    }
    .wordmark {
      margin: 0;
      font-size: clamp(34px, 8vw, 68px);
      font-weight: 500;
      line-height: 0.96;
      text-transform: uppercase;
      background: linear-gradient(90deg, #2f392c 0%, #2f392c 24%, #c4a265 50%, #2f392c 76%, #2f392c 100%);
      background-size: 300% 100%;
      background-clip: text;
      -webkit-background-clip: text;
      color: transparent;
      animation: shimmer 8s ease-in-out infinite, glow 8s ease-in-out infinite;
    }
    .copy {
      display: grid;
      gap: 14px;
      max-width: 520px;
    }
    p {
      color: rgba(47, 57, 44, 0.68);
      font-size: 16px;
      line-height: 1.65;
      margin: 0;
    }
    .status {
      min-height: 34px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      border: 1px solid rgba(47, 57, 44, 0.12);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.48);
      padding: 7px 12px;
      color: rgba(47, 57, 44, 0.72);
      font-size: 13px;
      box-shadow: 0 12px 40px rgba(47, 57, 44, 0.08);
    }
    strong { color: #2f392c; font-weight: 700; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes shimmer {
      0%, 100% { background-position: 200% 0; }
      50% { background-position: -100% 0; }
    }
    @keyframes glow {
      0%, 100% { filter: brightness(1); }
      50% { filter: brightness(1.12); }
    }
    @media (prefers-reduced-motion: reduce) {
      .mark::before, .wordmark { animation-duration: 1ms; animation-iteration-count: 1; }
    }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true"></div>
    <div class="copy">
      <h1 class="wordmark">${title}</h1>
      <p>${detail}</p>
    </div>
    <p class="status">Instance status: <strong>${escapeHtml(input.status)}</strong></p>
  </main>
</body>
</html>`;
}

const SERVER_STRENGTHS: Record<string, { vcpu: number; memoryGiB: number; diskGiB?: number }> = {
  cpx11: { vcpu: 2, memoryGiB: 2, diskGiB: 40 },
  cpx21: { vcpu: 3, memoryGiB: 4, diskGiB: 80 },
  cpx22: { vcpu: 2, memoryGiB: 4, diskGiB: 80 },
  cpx31: { vcpu: 4, memoryGiB: 8, diskGiB: 160 },
  cpx41: { vcpu: 8, memoryGiB: 16, diskGiB: 240 },
  cpx51: { vcpu: 16, memoryGiB: 32, diskGiB: 360 },
  cx22: { vcpu: 2, memoryGiB: 4, diskGiB: 40 },
  cx32: { vcpu: 4, memoryGiB: 8, diskGiB: 80 },
  cx42: { vcpu: 8, memoryGiB: 16, diskGiB: 160 },
  cx52: { vcpu: 16, memoryGiB: 32, diskGiB: 320 },
};

function machineStrength(machine: UserMachineRecord): {
  serverType: string;
  label: string;
  detail: string;
} {
  const serverType = machine.serverType;
  if (!serverType) {
    return {
      serverType: 'Unknown plan',
      label: 'Unknown',
      detail: 'CPU/RAM unavailable',
    };
  }
  const strength = SERVER_STRENGTHS[serverType.toLowerCase()];
  if (!strength) {
    return {
      serverType,
      label: serverType,
      detail: 'CPU/RAM unavailable',
    };
  }
  return {
    serverType,
    label: `${strength.vcpu} vCPU`,
    detail: `${strength.memoryGiB} GB RAM${strength.diskGiB ? ` · ${strength.diskGiB} GB disk` : ''}`,
  };
}

type RuntimePickerMachine = UserMachineRecord & {
  displayVersion: string;
};

function releaseVersionFromProbe(probe: Awaited<ReturnType<typeof probeCustomerVpsRelease>>): string | null {
  const release = probe.release;
  if (!release || typeof release !== 'object' || !('version' in release)) {
    return null;
  }
  const version = (release as { version?: unknown }).version;
  return typeof version === 'string' && version.trim() ? version : null;
}

async function buildRuntimePickerMachines(
  machines: UserMachineRecord[],
  platformSecret: string,
): Promise<RuntimePickerMachine[]> {
  const enriched = await Promise.allSettled(machines.map(async (machine): Promise<RuntimePickerMachine> => {
    if (machine.status !== 'running' || !platformSecret) {
      return { ...machine, displayVersion: machine.imageVersion ?? 'Version pending' };
    }
    const probe = await probeCustomerVpsRelease(machine, platformSecret, {
      timeoutMs: RUNTIME_PICKER_PROBE_TIMEOUT_MS,
    });
    return {
      ...machine,
      displayVersion: releaseVersionFromProbe(probe) ?? machine.imageVersion ?? 'Version pending',
    };
  }));
  return enriched.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    return {
      ...machines[index]!,
      displayVersion: machines[index]?.imageVersion ?? 'Version pending',
    };
  });
}

function getRuntimePickerPage(input: {
  machines: RuntimePickerMachine[];
  selectedHandle: string | null;
}): string {
  const rows = input.machines.map((machine) => {
    const strength = machineStrength(machine);
    const isSelected = machine.handle === input.selectedHandle;
    const version = machine.displayVersion;
    const title = machine.runtimeSlot === 'primary' ? 'Main Computer' : `${machine.runtimeSlot} Computer`;
    const started = new Date(machine.provisionedAt).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });
    const statusClass = machine.status === 'running' ? 'good' : machine.status === 'failed' ? 'bad' : 'wait';
    return `<a class="machine ${isSelected ? 'selected' : ''}" href="/vm/${encodeURIComponent(machine.handle)}">
      <div class="topline">
        <div>
          <strong>${escapeHtml(title)}</strong>
          <span>${escapeHtml(machine.handle)}</span>
        </div>
        <em class="${statusClass}">${escapeHtml(machine.status)}</em>
      </div>
      <div class="details">
        <span>${escapeHtml(version)}</span>
        <span>${escapeHtml(strength.label)}</span>
        <span>${escapeHtml(strength.detail)}</span>
        <span>${escapeHtml(strength.serverType)}</span>
        <span>Created ${escapeHtml(started)}</span>
      </div>
    </a>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Select Matrix OS Machine</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #2f392c;
      background:
        radial-gradient(circle at 50% 42%, rgba(196, 162, 101, 0.12), transparent 31%),
        linear-gradient(180deg, #fffdf6 0%, #f5efe2 100%);
      display: grid;
      place-items: center;
      padding: 28px;
    }
    main { width: min(940px, 100%); }
    header { margin-bottom: 22px; }
    .eyebrow { color: rgba(47, 57, 44, 0.62); font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.22em; margin-bottom: 10px; }
    h1 {
      margin: 0;
      font-size: clamp(32px, 6vw, 64px);
      font-weight: 500;
      line-height: 0.98;
      text-transform: uppercase;
      background: linear-gradient(90deg, #2f392c 0%, #2f392c 24%, #c4a265 50%, #2f392c 76%, #2f392c 100%);
      background-size: 300% 100%;
      background-clip: text;
      -webkit-background-clip: text;
      color: transparent;
      animation: shimmer 8s ease-in-out infinite, glow 8s ease-in-out infinite;
    }
    p { color: rgba(47, 57, 44, 0.68); font-size: 16px; line-height: 1.6; max-width: 620px; margin: 14px 0 0; }
    .list { display: grid; gap: 12px; margin-top: 24px; }
    .machine {
      display: block;
      color: inherit;
      text-decoration: none;
      background: rgba(255, 255, 255, 0.64);
      border: 1px solid rgba(47, 57, 44, 0.12);
      border-radius: 8px;
      padding: 18px;
      box-shadow: 0 18px 60px rgba(47, 57, 44, 0.10);
      backdrop-filter: blur(16px);
      transition: transform 140ms ease, border-color 140ms ease, background 140ms ease;
    }
    .machine:hover { transform: translateY(-1px); border-color: rgba(196, 162, 101, 0.55); background: rgba(255, 255, 255, 0.82); }
    .machine.selected { border-color: rgba(196, 162, 101, 0.82); }
    .topline { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
    strong { display: block; font-size: 20px; text-transform: capitalize; }
    .topline span { display: block; color: rgba(47, 57, 44, 0.62); font-size: 14px; margin-top: 4px; }
    em {
      flex: 0 0 auto;
      border-radius: 999px;
      padding: 6px 10px;
      font-size: 12px;
      font-style: normal;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    em.good { color: #075f3b; background: rgba(223, 246, 232, 0.9); }
    em.wait { color: #74520a; background: rgba(255, 240, 199, 0.92); }
    em.bad { color: #8a1f2b; background: rgba(255, 225, 229, 0.92); }
    .details {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 14px;
    }
    .details span {
      min-height: 30px;
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      background: rgba(47, 57, 44, 0.06);
      color: rgba(47, 57, 44, 0.78);
      padding: 6px 10px;
      font-size: 13px;
      white-space: nowrap;
    }
    @media (max-width: 560px) {
      body { padding: 18px; place-items: start center; }
      .topline { align-items: flex-start; }
      .details span { width: 100%; justify-content: space-between; }
    }
    @keyframes shimmer {
      0%, 100% { background-position: 200% 0; }
      50% { background-position: -100% 0; }
    }
    @keyframes glow {
      0%, 100% { filter: brightness(1); }
      50% { filter: brightness(1.12); }
    }
    @media (prefers-reduced-motion: reduce) {
      h1 { animation-duration: 1ms; animation-iteration-count: 1; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="eyebrow">Switch Computer</div>
      <h1>Choose your Matrix OS computer</h1>
      <p>Use your main computer for daily work, or jump into a named test VM when validating a risky feature.</p>
    </header>
    <section class="list" aria-label="Available Matrix OS machines">
      ${rows}
    </section>
  </main>
</body>
</html>`;
}

/**
 * Startup assertion for the trusted-sync architecture: user containers no
 * longer receive raw S3 credentials. When MATRIX_HOME_MIRROR=true, the
 * container gateway reaches storage through the platform's internal sync API,
 * so the platform itself must hold the trusted storage config plus the
 * PLATFORM_SECRET used for per-container HMAC auth. Warn loudly at startup
 * instead of discovering silent sync failure after deploy.
 *
 * Returns the list of missing logical requirements (empty if all is well or
 * home-mirror is disabled). Exposed for tests; callers typically just discard
 * the return value after logging.
 */
export function checkHomeMirrorS3Env(
  env: NodeJS.ProcessEnv = process.env,
  log: (msg: string) => void = console.warn,
): string[] {
  if (env.MATRIX_HOME_MIRROR !== 'true') return [];
  const missing: string[] = [];
  if (!(env.S3_ENDPOINT || env.R2_ENDPOINT || env.R2_ACCOUNT_ID)) {
    missing.push('S3_ENDPOINT/R2_ENDPOINT or R2_ACCOUNT_ID');
  }
  if (!(env.S3_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID)) {
    missing.push('S3_ACCESS_KEY_ID/R2_ACCESS_KEY_ID');
  }
  if (!(env.S3_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY)) {
    missing.push('S3_SECRET_ACCESS_KEY/R2_SECRET_ACCESS_KEY');
  }
  if (!(env.S3_BUCKET || env.R2_BUCKET)) {
    missing.push('S3_BUCKET/R2_BUCKET');
  }
  if (!env.PLATFORM_SECRET) {
    missing.push('PLATFORM_SECRET');
  }
  if (missing.length > 0) {
    log(
      `[platform] MATRIX_HOME_MIRROR=true but trusted sync storage is incomplete; user containers no longer receive raw S3 credentials and must proxy sync storage through the platform. Missing: ${missing.join(', ')}.`,
    );
  }
  return missing;
}

export type PlatformApp = Hono<{
  Variables: {
    platformUserId: string;
    platformHandle: string;
    internalContainerHandle: string;
    internalContainerClerkUserId: string;
  };
}> & {
  capturePlatformEvent(
    event: string,
    properties: Record<string, string | number | boolean | null | undefined>,
  ): void;
  shutdownPostHog(): Promise<void>;
};

export function createApp(deps: {
  db: PlatformDB;
  docker?: Dockerode;
  orchestrator: Orchestrator;
  clerkAuth?: ClerkAuth;
  matrixProvisioner?: MatrixProvisioner;
  platformSecret?: string;
  integrationRoutes?: Hono<any>;
  internalIntegrationRoutes?: Hono<any>;
  internalSyncRoutes?: Hono<any>;
  customerVpsService?: CustomerVpsService;
  customerVpsObjectStore?: CustomerVpsObjectStore;
  env?: NodeJS.ProcessEnv;
}) {
  const { db, docker, orchestrator, clerkAuth, matrixProvisioner } = deps;
  const appEnv = deps.env ?? process.env;
  const platformSecret = deps.platformSecret ?? appEnv.PLATFORM_SECRET ?? '';
  type CachedVpsRuntimeMetrics = {
    machineKey: string;
    expiresAt: number;
    values: VpsRuntimeMetricInput[];
  };
  let cachedVpsRuntimeMetrics: CachedVpsRuntimeMetrics | null = null;
  let pendingVpsRuntimeMetrics: {
    machineKey: string;
    promise: Promise<CachedVpsRuntimeMetrics>;
  } | null = null;

  function getVpsRuntimeMetricsCacheKey(
    machines: Array<{
      machineId: string;
      handle: string;
      status: string;
      publicIPv4: string | null;
      imageVersion: string | null;
    }>,
  ): string {
    return machines
      .map((machine) => [
        machine.machineId,
        machine.handle,
        machine.status,
        machine.publicIPv4 ?? '',
        machine.imageVersion ?? '',
      ].join(':'))
      .sort()
      .join('|');
  }

  function updateCachedVpsRuntimeMetrics(
    machines: Array<{
      machineId: string;
      handle: string;
      status: string;
      publicIPv4: string | null;
      imageVersion: string | null;
    }>,
    values: VpsRuntimeMetricInput[],
  ): void {
    cachedVpsRuntimeMetrics = {
      machineKey: getVpsRuntimeMetricsCacheKey(machines),
      expiresAt: Date.now() + VPS_RUNTIME_METRICS_TTL_MS,
      values,
    };
  }

  async function getCachedVpsRuntimeMetrics(
    machines: UserMachineRecord[],
  ): Promise<VpsRuntimeMetricInput[]> {
    const now = Date.now();
    const machineKey = getVpsRuntimeMetricsCacheKey(machines);
    if (
      cachedVpsRuntimeMetrics
      && cachedVpsRuntimeMetrics.machineKey === machineKey
      && cachedVpsRuntimeMetrics.expiresAt > now
    ) {
      return cachedVpsRuntimeMetrics.values;
    }
    if (pendingVpsRuntimeMetrics?.machineKey === machineKey) {
      return (await pendingVpsRuntimeMetrics.promise).values;
    }
    const probeStartedAt = Date.now();
    const promise = Promise.allSettled(
      machines.map(async (machine): Promise<VpsRuntimeMetricInput> => ({
        handle: machine.handle,
        ...(machine.status === 'running'
          ? await probeCustomerVpsRuntime(machine, platformSecret)
          : { healthy: false }),
      })),
    ).then((probed) => {
      const values = probed
        .filter((result): result is PromiseFulfilledResult<VpsRuntimeMetricInput> => result.status === 'fulfilled')
        .map((result) => result.value);
      const updated = {
        machineKey,
        expiresAt: probeStartedAt + VPS_RUNTIME_METRICS_TTL_MS,
        values,
      };
      if (
        !cachedVpsRuntimeMetrics
        || (
          cachedVpsRuntimeMetrics.machineKey === machineKey
          && cachedVpsRuntimeMetrics.expiresAt < updated.expiresAt
        )
      ) {
        cachedVpsRuntimeMetrics = updated;
      }
      return cachedVpsRuntimeMetrics.machineKey === machineKey ? cachedVpsRuntimeMetrics : updated;
    }).catch((err: unknown): CachedVpsRuntimeMetrics => {
      logPlatformRouteError('/metrics vps runtime cache', err);
      if (cachedVpsRuntimeMetrics?.machineKey === machineKey) {
        return cachedVpsRuntimeMetrics;
      }
      return { machineKey, expiresAt: 0, values: [] };
    }).finally(() => {
      if (pendingVpsRuntimeMetrics?.machineKey === machineKey) {
        pendingVpsRuntimeMetrics = null;
      }
    });
    pendingVpsRuntimeMetrics = { machineKey, promise };
    return (await promise).values;
  }
  const app = new Hono<{
    Variables: {
      platformUserId: string;
      platformHandle: string;
      internalContainerHandle: string;
      internalContainerClerkUserId: string;
    };
  }>() as PlatformApp;
  const posthogErrorTracker = installPostHogHonoErrorTracking(app, {
    service: 'matrix-platform',
  });
  const posthogShutdowns: Array<() => Promise<void>> = [() => posthogErrorTracker.shutdown()];
  function capturePlatformEvent(
    event: string,
    properties: Record<string, string | number | boolean | null | undefined>,
  ): void {
    void posthogErrorTracker.captureEvent(event, {
      distinctId: 'matrix-platform',
      properties,
    }).catch((err: unknown) => {
      const kind = err instanceof Error ? err.name : typeof err;
      console.warn(`[posthog] Failed to queue platform event ${event}: ${kind}`);
    });
  }
  app.capturePlatformEvent = capturePlatformEvent;

  app.use('*', async (c, next) => {
    const started = performance.now();
    let status = 500;
    try {
      await next();
      status = c.res.status;
    } finally {
      if (c.req.path !== '/metrics') {
        recordPlatformHttpRequest({
          method: c.req.method,
          path: c.req.path,
          status,
          durationSeconds: (performance.now() - started) / 1000,
        });
      }
    }
  });

  // Health check (unauthenticated)
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Matrix well-known endpoints (unauthenticated, required for federation)
  const CONDUIT_SERVER = process.env.CONDUIT_SERVER ?? 'matrix-os.com:6167';
  const CONDUIT_BASE_URL = process.env.CONDUIT_BASE_URL ?? 'https://matrix-os.com';

  app.get('/.well-known/matrix/server', (c) =>
    c.json({ 'm.server': CONDUIT_SERVER }),
  );
  app.get('/.well-known/matrix/client', (c) =>
    c.json({ 'm.homeserver': { base_url: CONDUIT_BASE_URL } }),
  );

  // Prometheus metrics (unauthenticated for scraping)
  app.get('/metrics', async (c) => {
    const {
      metricsRegistry,
      refreshPlatformUserMetrics,
      refreshReleaseChannelMetrics,
      refreshVpsMetrics,
      refreshVpsRuntimeMetrics,
    } = await import('./metrics.js');
    try {
      const machines = await listAllUserMachines(db, 500);
      const containers = await listContainers(db);
      refreshVpsMetrics(machines);
      refreshPlatformUserMetrics({ machines, containers });
      const releaseChannels = await Promise.all(
        ['dev', 'beta', 'canary', 'stable'].map(async (channel) => {
          const release = await getHostBundleReleaseByChannel(db, channel);
          return release ? { ...release, channel } : null;
        }),
      );
      refreshReleaseChannelMetrics(
        releaseChannels.filter((release): release is NonNullable<typeof release> => release !== null),
      );
      if (deps.customerVpsService) {
        refreshVpsRuntimeMetrics(await getCachedVpsRuntimeMetrics(machines));
      }
    } catch (err: unknown) {
      logPlatformRouteError('/metrics vps refresh', err);
    }
    const metrics = await metricsRegistry.metrics();
    return c.text(metrics, 200, {
      'Content-Type': metricsRegistry.contentType,
    });
  });

  async function getSignedBundleUrl(release: HostBundleReleaseRecord): Promise<string> {
    if (!deps.customerVpsObjectStore) {
      throw new Error('Host bundle storage unavailable');
    }
    if (!deps.customerVpsObjectStore.getPresignedGetUrl) {
      throw new Error('Host bundle storage cannot create signed URLs');
    }
    return deps.customerVpsObjectStore.getPresignedGetUrl(release.bundleKey, 3600);
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

  app.get('/system-bundles/releases', async (c) => {
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
      logPlatformRouteError('/system-bundles/releases', err);
      return c.json({ error: 'Host bundle unavailable' }, 502);
    }
  });

  app.get('/system-bundles/releases/:versionJson', async (c) => {
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
      logPlatformRouteError('/system-bundles/releases/:version', err);
      return c.json({ error: 'Host bundle unavailable' }, 502);
    }
  });

  app.post('/system-bundles/releases', bodyLimit({ maxSize: ADMIN_BODY_LIMIT }), async (c) => {
    const authError = requireHostBundleAdmin(c);
    if (authError) return authError;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err: unknown) {
      logPlatformRouteError('/system-bundles/releases parse', err);
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
      logPlatformRouteError('/system-bundles/releases', err);
      return c.json({ error: 'Host bundle unavailable' }, 502);
    }
  });

  app.post('/system-bundles/channels/:channel', bodyLimit({ maxSize: ADMIN_BODY_LIMIT }), async (c) => {
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
      logPlatformRouteError('/system-bundles/channels parse', err);
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
      logPlatformRouteError('/system-bundles/channels/:channel promote', err);
      return c.json({ error: 'Host bundle unavailable' }, 502);
    }
  });

  // Public, immutable host-service bundles used by customer VPS cloud-init.
  // Metadata comes from Postgres; R2 only stores the bytes.
  app.get('/system-bundles/:imageVersion/:file', async (c) => {
    if (!deps.customerVpsObjectStore) {
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
        logPlatformRouteError('/system-bundles/channels/:channel', err);
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
      logPlatformRouteError('/system-bundles/:imageVersion/:file db', err);
      return c.json({ error: 'Host bundle unavailable' }, 502);
    }
    if (!release) {
      return c.json({ error: 'Not found' }, 404);
    }

    if (file.endsWith('.tar.gz') && deps.customerVpsObjectStore.getPresignedGetUrl) {
      try {
        const url = await getSignedBundleUrl(release);
        return c.redirect(url, 302);
      } catch (err: unknown) {
        if (isObjectNotFoundError(err)) {
          return c.json({ error: 'Not found' }, 404);
        }
        logPlatformRouteError('/system-bundles/:imageVersion/:file', err);
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

    if (file.endsWith('.json')) {
      try {
        const url = await getSignedBundleUrl(release);
        return c.json(hostBundleReleaseResponse(release, url, isChannelAlias ? imageVersion : undefined), 200, {
          'cache-control': 'private, max-age=30',
        });
      } catch (err: unknown) {
        logPlatformRouteError('/system-bundles/:imageVersion/:file json', err);
        return c.json({ error: 'Host bundle unavailable' }, 502);
      }
    }

    try {
      const object = await deps.customerVpsObjectStore.getObject(
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
      logPlatformRouteError('/system-bundles/:imageVersion/:file', err);
      return c.json({ error: 'Host bundle unavailable' }, 502);
    }
  });

  app.get('/system-bundles/channels/:channel', async (c) => {
    if (!deps.customerVpsObjectStore) {
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
      logPlatformRouteError('/system-bundles/channels/:channel', err);
      return c.json({ error: 'Host bundle unavailable' }, 502);
    }
  });

  // OAuth 2.0 Device Flow (RFC 8628) -- mounted before any host-based routing
  // so the CLI's poll/code endpoints work regardless of which subdomain hits
  // the platform. Public endpoints; admin Bearer middleware below skips them.
  const platformJwtSecret = process.env.PLATFORM_JWT_SECRET ?? '';
  if (platformJwtSecret) {
    const platformPublicUrl =
      process.env.PLATFORM_PUBLIC_URL ?? `http://localhost:${process.env.PLATFORM_PORT ?? 9000}`;
    app.route(
      '/',
      createAuthRoutes({
        db,
        clerkAuth,
        jwtSecret: platformJwtSecret,
        platformUrl: platformPublicUrl,
        gatewayUrlForHandle: getGatewayUrlForHandle,
        captureEvent: capturePlatformEvent,
      }),
    );
  }

  // Session-based routing:
  // - app.matrix-os.com -> Clerk session -> Matrix OS shell/gateway
  // - code.matrix-os.com -> Clerk session -> code-server on the user's VPS
  app.use('*', bodyLimit({ maxSize: PROXY_BODY_LIMIT }), async (c, next) => {
    const host = c.req.header('host') ?? '';
    const isAppDomain = isAppDomainHost(host);
    const isCodeDomain = isCodeDomainHost(host);
    if (!isAppDomain && !isCodeDomain) return next();

    // Device-flow paths are served directly by the platform's auth-routes.ts
    // (registered above). In normal dispatch they never reach this middleware,
    // but we short-circuit explicitly so a misconfigured PLATFORM_JWT_SECRET or
    // a future refactor can't accidentally proxy them into a user container.
    const reqPath = c.req.path;
    if (isAppDomain && (
      reqPath === '/auth/device' ||
      reqPath.startsWith('/auth/device/') ||
      reqPath.startsWith('/api/auth/device/')
    )) {
      return next();
    }
    if ((isAppDomain || isCodeDomain) && (reqPath === '/vps' || reqPath.startsWith('/vps/'))) {
      return next();
    }
    if ((isAppDomain || isCodeDomain) && reqPath.startsWith('/internal/containers/')) {
      return next();
    }
    const isPublicIntegrationPath =
      reqPath === '/api/integrations/available' ||
      reqPath.startsWith('/api/integrations/webhook/');
    const isIntegrationPath =
      reqPath === '/api/integrations' || reqPath.startsWith('/api/integrations/');
    if (isAppDomain && isPublicIntegrationPath) {
      return next();
    }
    if (isAppDomain && reqPath === '/voice/webhook/twilio') {
      const webhookUrl = new URL(c.req.url);
      const handle = webhookUrl.searchParams.get('handle') ?? '';
      if (!HANDLE_PATTERN.test(handle)) {
        return c.json({ error: 'Invalid handle' }, 400);
      }

      const runningMachine = await getRunningUserMachineByHandle(db, handle);
      if (!runningMachine) {
        return c.json({ error: 'VPS unavailable' }, 404);
      }

      const qs = buildForwardedQueryString(c.req.url);
      const targetUrl = buildCustomerVpsProxyUrl(runningMachine, reqPath, qs);
      if (!targetUrl) {
        return c.json({ error: 'VPS unreachable' }, 502);
      }

      const headers = new Headers();
      for (const [key, value] of Object.entries(c.req.header())) {
        const lowerKey = key.toLowerCase();
        if (lowerKey !== 'host' && !SENSITIVE_PROXY_HEADERS.has(lowerKey) && value) {
          headers.set(key, value);
        }
      }
      headers.set('host', 'app.matrix-os.com');
      headers.set('x-forwarded-host', host);
      headers.set('x-forwarded-proto', 'https');
      headers.set('accept-encoding', 'identity');
      headers.set('connection', 'close');
      if (platformSecret) {
        headers.set('authorization', `Bearer ${buildPlatformVerificationToken(handle, platformSecret)}`);
      }

      try {
        const upstream = await fetch(targetUrl, {
          method: c.req.method,
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
          body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.blob(),
          dispatcher: customerVpsProxyDispatcher,
        } as RequestInit & { dispatcher: Agent });

        return new Response(upstream.body, {
          status: upstream.status,
          headers: sanitizeProxyResponseHeaders(upstream.headers),
        });
      } catch (err: unknown) {
        logPlatformRouteError('app-domain voice webhook proxy', err);
        return c.json({ error: 'VPS unreachable' }, 502);
      }
    }

    const authHeader = c.req.header('authorization');
    const cookieHeader = c.req.header('cookie');
    const path = c.req.path;
    const explicitVmRoute = isAppDomain ? readExplicitVmRoute(path) : null;
    const runtimeSelection = readRuntimeSlotSelection(c.req.url);
    const requestRuntimeSlot = runtimeSelection.slot;
    let singleMachineRuntimeSlot: string | null = null;

    const isGatewayPath = isAppDomain && isAppDomainGatewayPath(path);
    const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    const authMode = path.startsWith('/sign-up') ? 'sign-up' : 'sign-in';
    const requestedRouteHandle = !explicitVmRoute && isAppDomain
      ? readAppDomainRouteCookie(path, cookieHeader)
      : null;

    let identity = await resolveAppDomainIdentity({
      authHeader,
      cookieHeader,
      clerkAuth,
      db,
      platformJwtSecret,
      allowUnroutedClerkIdentity: Boolean(explicitVmRoute),
      requestedHandle: requestedRouteHandle,
      runtimeSlot: requestRuntimeSlot,
    });
    if (!identity && isAppDomain) {
      const mobileSessionHandle =
        readMobileAppSessionRoutingHandle(path, c.req.url) ??
        readMobileAppRouteCookie(path, cookieHeader);
      if (mobileSessionHandle) {
        identity = {
          handle: mobileSessionHandle,
          userId: '',
          source: 'mobile-session',
        };
      }
    }
    if (!identity && isAppDomain && isAppDomainStaticAssetPath(path)) {
      const shellRouteHandle = readShellRouteCookie(path, cookieHeader);
      if (shellRouteHandle) {
        identity = {
          handle: shellRouteHandle,
          userId: '',
          source: 'static-route',
        };
      }
    }
    const isCookieRoutedShellAsset = Boolean(
      identity &&
      requestedRouteHandle &&
      identity.handle === requestedRouteHandle &&
      isAppDomain &&
      isAppDomainStaticAssetPath(path),
    );

    // No session/JWT -- serve Clerk auth directly from the platform.
    if (!identity) {
      console.log(`[${isCodeDomain ? 'code' : 'app'}] no token path=${path}`);
      if (isCodeDomain && isCodeDomainStaticAssetPath(path)) {
        applyNoStoreHeaders(c);
        return c.text('Unauthorized', 401);
      }
      if (isAppDomain && isAppDomainStaticAssetPath(path)) {
        applyNoStoreHeaders(c);
        return c.text('Unauthorized', 401);
      }
      if (isGatewayPath && requestedRouteHandle) {
        applyNoStoreHeaders(c);
        return c.json({ error: 'Matrix computer unavailable', code: 'machine_unavailable' }, 410);
      }
      if (isGatewayPath) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if (!publishableKey || !clerkAuth) {
        return c.text('Clerk publishable key not configured', 500);
      }
      const scriptNonce = randomBytes(16).toString('base64');
      applyAuthPageHeaders(c, scriptNonce);
      return c.html(getAuthPage(publishableKey, authMode, scriptNonce, buildPostAuthRedirectPath(c.req.url)));
    }

    console.log(`[${isCodeDomain ? 'code' : 'app'}] verified request path=${path}`);
    if (isAppDomain && path === '/vm') {
      return c.redirect('/runtime');
    }
    if (isAppDomain && path.startsWith('/vm/') && !explicitVmRoute) {
      return c.text('Invalid Matrix OS computer', 400);
    }
    if (isAppDomain && explicitVmRoute) {
      if (!identity.userId || identity.source === 'mobile-session' || identity.source === 'static-route') {
        applyNoStoreHeaders(c);
        return c.text('Unauthorized', 401);
      }
      const machine = await getActiveUserMachineByHandle(db, explicitVmRoute.handle);
      if (!machine || machine.clerkUserId !== identity.userId) {
        applyNoStoreHeaders(c);
        return c.text('Matrix OS computer unavailable', 404);
      }
      const entitlement = getRuntimeEntitlementDecision(appEnv);
      if (!entitlement.runtimeProxyAllowed) {
        applyNoStoreHeaders(c);
        return c.json({ error: 'Paid beta access required' }, 402);
      }
      if (machine.status !== 'running') {
        if (isGatewayPath) {
          applyNoStoreHeaders(c);
          return c.json({
            error: 'VPS provisioning',
            status: machine.status,
          }, 503);
        }
        applyNoStoreHeaders(c);
        return c.html(getVpsBootPage({ status: machine.status }), 503);
      }
      const qs = buildForwardedQueryString(c.req.url);
      const targetUrl = buildCustomerVpsProxyUrl(machine, explicitVmRoute.upstreamPath, qs);
      if (!targetUrl) {
        return c.json({ error: 'VPS unreachable' }, 502);
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(c.req.header())) {
        if (key !== 'host' && key !== 'cookie' && key !== 'authorization' && value) {
          headers.set(key, value);
        }
      }
      const rawCookie = c.req.header('cookie');
      if (rawCookie) {
        const forwarded = rawCookie
          .split(';')
          .map((p) => p.trim())
          .filter((p) => p.startsWith('matrix_app_session__'))
          .join('; ');
        if (forwarded) headers.set('cookie', forwarded);
      }
      headers.set('host', `${machine.handle}.matrix-os.com`);
      headers.set('x-forwarded-host', host);
      headers.set('x-forwarded-proto', 'https');
      headers.set('accept-encoding', 'identity');
      headers.set('connection', 'close');
      if (platformSecret) {
        headers.set('authorization', `Bearer ${buildPlatformVerificationToken(machine.handle, platformSecret)}`);
        headers.set('x-platform-user-id', identity.userId);
        headers.set('x-platform-verified', buildPlatformUserProof(machine.handle, identity.userId, platformSecret));
      }

      try {
        const upstream = await fetch(targetUrl, {
          method: c.req.method,
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
          body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.blob(),
          dispatcher: customerVpsProxyDispatcher,
        } as RequestInit & { dispatcher: Agent });

        const responseHeaders = sanitizeProxyResponseHeaders(upstream.headers);
        responseHeaders.append('set-cookie', buildShellRouteCookie(machine.handle));
        return new Response(upstream.body, {
          status: upstream.status,
          headers: responseHeaders,
        });
      } catch (err: unknown) {
        logPlatformRouteError('app-domain explicit vps proxy', err);
        return c.json({ error: 'VPS unreachable' }, 502);
      }
    }

    if (isAppDomain && isIntegrationPath) {
      c.set('platformUserId', identity.userId);
      c.set('platformHandle', identity.handle);
      return next();
    }

    if (isAppDomain && path === '/api/auth/ws-token') {
      if (!platformJwtSecret) {
        return c.json({ error: 'WebSocket auth unavailable' }, 503);
      }
      const issued = await issueSyncJwt({
        secret: platformJwtSecret,
        clerkUserId: identity.userId,
        handle: identity.handle,
        gatewayUrl: getGatewayUrlForHandle(identity.handle),
        runtimeSlot: identity.runtimeSlot ?? requestRuntimeSlot,
        expiresInSec: WS_TOKEN_EXPIRES_IN_SEC,
      });
      return c.json({
        token: issued.token,
        expiresAt: issued.expiresAt,
      });
    }

    const shouldOfferRuntimePicker =
      isAppDomain &&
      identity.userId &&
      identity.source !== 'mobile-session' &&
      identity.source !== 'static-route' &&
      path === '/runtime';
    if (shouldOfferRuntimePicker) {
      const machines = await listActiveUserMachinesByClerkId(db, identity.userId);
      if (machines.length === 0 && path === '/runtime') {
        return c.redirect('/');
      }
      if (path === '/runtime' || machines.length > 1) {
        const pickerMachines = await buildRuntimePickerMachines(machines, platformSecret);
        applyNoStoreHeaders(c);
        c.header('X-Frame-Options', 'DENY');
        c.header('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
        return c.html(getRuntimePickerPage({ machines: pickerMachines, selectedHandle: identity.handle }));
      }
      if (machines.length === 1 && runtimeSelection.source === 'default') {
        singleMachineRuntimeSlot = machines[0]!.runtimeSlot;
      }
    }

    let runtimeSlot = identity.runtimeSlot ?? singleMachineRuntimeSlot ?? requestRuntimeSlot;
    let requestedActiveMachine: UserMachineRecord | undefined;
    let runningMachine = identity.userId
      ? await getRunningUserMachineByClerkId(db, identity.userId, runtimeSlot)
      : await getRunningUserMachineByHandle(db, identity.handle);
    if (!runningMachine && identity.userId) {
      requestedActiveMachine = await getActiveUserMachineByClerkId(db, identity.userId, runtimeSlot);
      if (!requestedActiveMachine) {
        const handleMachine = await getRunningUserMachineByHandle(db, identity.handle);
        if (handleMachine?.clerkUserId === identity.userId) {
          runningMachine = handleMachine;
        }
      }
    }
    if (runningMachine) {
      runtimeSlot = runningMachine.runtimeSlot;
    }
    const entitlement = getRuntimeEntitlementDecision(appEnv);
    if (runningMachine) {
      const qs = buildForwardedQueryString(c.req.url);
      if (!entitlement.runtimeProxyAllowed) {
        applyNoStoreHeaders(c);
        return c.json({ error: 'Paid beta access required' }, 402);
      }
      const targetUrl = buildCustomerVpsProxyUrl(runningMachine, path, qs);
      if (!targetUrl) {
        return c.json({ error: 'VPS unreachable' }, 502);
      }
      const body = ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.blob();
      const headers = isCodeDomain
        ? buildCodeDomainProxyHeaders(
            c.req.header(),
            host,
            platformSecret ? buildPlatformVerificationToken(runningMachine.handle, platformSecret) : undefined,
          )
        : new Headers();
      if (!isCodeDomain) {
        for (const [key, value] of Object.entries(c.req.header())) {
          if (key !== 'host' && key !== 'cookie' && key !== 'authorization' && value) {
            headers.set(key, value);
          }
        }
        const rawCookie = c.req.header('cookie');
        if (rawCookie) {
          const forwarded = rawCookie
            .split(';')
            .map((p) => p.trim())
            .filter((p) => p.startsWith('matrix_app_session__'))
            .join('; ');
          if (forwarded) headers.set('cookie', forwarded);
        }
        headers.set('host', `${runningMachine.handle}.matrix-os.com`);
        headers.set('x-forwarded-host', host);
        headers.set('x-forwarded-proto', 'https');
        headers.set('accept-encoding', 'identity');
        headers.set('connection', 'close');
      }
      if (platformSecret) {
        headers.set('authorization', `Bearer ${buildPlatformVerificationToken(runningMachine.handle, platformSecret)}`);
        const platformUserId =
          identity.source === 'static-route' ? runningMachine.clerkUserId : identity.userId;
        if (platformUserId) {
          headers.set('x-platform-user-id', platformUserId);
          if (identity.source !== 'mobile-session' && identity.source !== 'static-route') {
            headers.set('x-platform-verified', buildPlatformUserProof(runningMachine.handle, platformUserId, platformSecret));
          }
        }
      }

      try {
        const upstream = await fetch(targetUrl, {
          method: c.req.method,
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
          body,
          dispatcher: customerVpsProxyDispatcher,
        } as RequestInit & { dispatcher: Agent });

        const responseHeaders = sanitizeProxyResponseHeaders(upstream.headers);
        if ((identity.source === 'static-route' || isCookieRoutedShellAsset) && isAppDomainStaticAssetPath(path)) {
          applyCookieRoutedShellAssetCacheHeaders(responseHeaders);
        }
        if (identity.source === 'mobile-session') {
          const routeCookie = buildAppRouteCookie(runningMachine.handle, path);
          if (routeCookie) responseHeaders.append('set-cookie', routeCookie);
        }
        if (isAppDomain && identity.source !== 'static-route') {
          responseHeaders.append('set-cookie', buildShellRouteCookie(runningMachine.handle));
        }
        if (isCodeDomain && platformJwtSecret) {
          const issued = await issueSyncJwt({
            secret: platformJwtSecret,
            clerkUserId: identity.userId,
            handle: runningMachine.handle,
            gatewayUrl: 'https://code.matrix-os.com',
            runtimeSlot,
            expiresInSec: CODE_SESSION_EXPIRES_IN_SEC,
          });
          responseHeaders.append('set-cookie', buildCodeSessionCookie(issued.token));
        }

        return new Response(upstream.body, {
          status: upstream.status,
          headers: responseHeaders,
        });
      } catch (err: unknown) {
        logPlatformRouteError(isCodeDomain ? 'code-domain vps proxy' : 'app-domain vps proxy', err);
        return c.json({ error: 'VPS unreachable' }, 502);
      }
    }

    const record = await getContainer(db, identity.handle);
    if (!record) {
      const activeMachine = requestedActiveMachine ?? (identity.userId
        ? await getActiveUserMachineByClerkId(db, identity.userId, runtimeSlot)
        : await getActiveUserMachineByHandle(db, identity.handle));
      if (activeMachine) {
        if (!entitlement.runtimeProxyAllowed) {
          applyNoStoreHeaders(c);
          return c.json({ error: 'Paid beta access required' }, 402);
        }
        if (isCodeDomain || isGatewayPath) {
          applyNoStoreHeaders(c);
          return c.json({
            error: 'VPS provisioning',
            status: activeMachine.status,
          }, 503);
        }
        applyNoStoreHeaders(c);
        return c.html(getVpsBootPage({ status: activeMachine.status }), 503);
      }
      return c.html(getNoContainerPage());
    }

    if (!entitlement.runtimeProxyAllowed) {
      applyNoStoreHeaders(c);
      return c.json({ error: 'Paid beta access required' }, 402);
    }

    if (record.status === 'stopped') {
      try {
        await orchestrator.start(record.handle);
      } catch (err: unknown) {
        logPlatformRouteError('app-domain container start', err);
        return c.json({ error: 'Failed to wake container' }, 503);
      }
    }

    await updateLastActive(db, record.handle);

    const qs = buildForwardedQueryString(c.req.url);
    const targetPort = isCodeDomain ? CODE_SERVER_PORT : (isGatewayPath || path === '/apps' || path.startsWith('/apps/')) ? 4000 : 3000;
    const body = ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.blob();
    const headers = isCodeDomain
      ? buildCodeDomainProxyHeaders(
          c.req.header(),
          host,
          platformSecret ? buildPlatformVerificationToken(record.handle, platformSecret) : undefined,
        )
      : new Headers();
    if (!isCodeDomain) {
      for (const [key, value] of Object.entries(c.req.header())) {
        if (key !== 'host' && key !== 'cookie' && key !== 'authorization' && value) {
          headers.set(key, value);
        }
      }
    }
    // Forward only the app-session cookies (spec 063). Clerk and other
    // cookies are stripped because gateway auth goes via the bearer token
    // set below; forwarding them would leak the user's Clerk session into
    // the container process.
    if (!isCodeDomain) {
      const rawCookie = c.req.header('cookie');
      if (rawCookie) {
        const forwarded = rawCookie
          .split(';')
          .map((p) => p.trim())
          .filter((p) => p.startsWith('matrix_app_session__'))
          .join('; ');
        if (forwarded) headers.set('cookie', forwarded);
      }
      headers.set('x-forwarded-host', host);
      headers.set('x-forwarded-proto', 'https');
      headers.set('accept-encoding', 'identity');
      headers.set('connection', 'close');
    }
    if (platformSecret && isAppDomain) {
      headers.set('authorization', `Bearer ${buildPlatformVerificationToken(record.handle, platformSecret)}`);
      const platformUserId =
        identity.source === 'static-route' ? record.clerkUserId : identity.userId;
      if (platformUserId) {
        headers.set('x-platform-user-id', platformUserId);
        if (identity.source !== 'mobile-session' && identity.source !== 'static-route') {
          headers.set('x-platform-verified', buildPlatformUserProof(record.handle, platformUserId, platformSecret));
        }
      }
    }

    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const endpoint = await resolveContainerEndpoint(docker, db, record.handle, record.containerId);
      if (!endpoint) {
        console.warn(
          `[platform] session-domain proxy unresolved handle=${record.handle} attempt=${attempt + 1} path=${path} targetPort=${targetPort}`,
        );
        return c.json({ error: 'Container unreachable' }, 502);
      }

      const targetUrl = `http://${endpoint.host}:${targetPort}${path}${qs}`;
      try {
        const upstream = await fetch(targetUrl, {
          method: c.req.method,
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
          body,
          dispatcher: containerProxyDispatcher,
        } as RequestInit & { dispatcher: Agent });

        const responseHeaders = sanitizeProxyResponseHeaders(upstream.headers);
        if ((identity.source === 'static-route' || isCookieRoutedShellAsset) && isAppDomainStaticAssetPath(path)) {
          applyCookieRoutedShellAssetCacheHeaders(responseHeaders);
        }
        if (identity.source === 'mobile-session') {
          const routeCookie = buildAppRouteCookie(record.handle, path);
          if (routeCookie) responseHeaders.append('set-cookie', routeCookie);
        }
        if (isAppDomain && identity.source !== 'static-route') {
          responseHeaders.append('set-cookie', buildShellRouteCookie(record.handle));
        }
        if (isCodeDomain && platformJwtSecret) {
          const issued = await issueSyncJwt({
            secret: platformJwtSecret,
            clerkUserId: identity.userId,
            handle: record.handle,
            gatewayUrl: 'https://code.matrix-os.com',
            expiresInSec: CODE_SESSION_EXPIRES_IN_SEC,
          });
          responseHeaders.append('set-cookie', buildCodeSessionCookie(issued.token));
        }

        return new Response(upstream.body, {
          status: upstream.status,
          headers: responseHeaders,
        });
      } catch (err: unknown) {
        lastErr = err;
        const routeName = isCodeDomain ? 'code-domain' : 'app-domain';
        console.warn(
          `[platform] ${routeName} proxy retry attempt=${attempt + 1} handle=${record.handle} target=${targetUrl} source=${endpoint.source} containerId=${endpoint.containerId ?? 'null'} error=${describeError(err)}`,
        );
      }
    }

    logPlatformRouteError(isCodeDomain ? 'code-domain proxy' : 'app-domain proxy', lastErr);
    return c.json({ error: 'Container unreachable' }, 502);
  });

  if (deps.integrationRoutes) {
    app.route('/api/integrations', deps.integrationRoutes);
  }
  if (deps.internalIntegrationRoutes) {
    const internalIntegrationApp = new Hono<{
      Variables: {
        internalContainerHandle: string;
        internalContainerClerkUserId: string;
      };
    }>();
    internalIntegrationApp.use('*', async (c, next) => {
      const handle = c.req.param('handle');
      if (!handle) {
        return c.json({ error: 'Missing handle' }, 400);
      }
      if (!platformSecret) {
        return c.json({ error: 'Internal integrations not configured' }, 503);
      }
      const auth = c.req.header('authorization');
      const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
      const expected = buildPlatformVerificationToken(handle, platformSecret);
      if (!timingSafeTokenEquals(token, expected)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const record = await getContainer(db, handle);
      if (!record?.clerkUserId) {
        return c.json({ error: 'Unknown handle' }, 404);
      }

      c.set('internalContainerHandle', handle);
      c.set('internalContainerClerkUserId', record.clerkUserId);
      return next();
    });
    internalIntegrationApp.route('/', deps.internalIntegrationRoutes);
    app.route('/internal/containers/:handle/integrations', internalIntegrationApp);
  }
  if (deps.internalSyncRoutes) {
    app.route('/internal/containers/:handle/sync', deps.internalSyncRoutes);
  }
  app.get('/vps/releases', async (c) => {
    if (!platformSecret) {
      return c.json({ error: 'VPS tracking not configured' }, 503);
    }
    const auth = c.req.header('authorization');
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    if (!timingSafeTokenEquals(token, platformSecret)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const machines = await listUserMachines(db);
    const rows = await Promise.all(machines.map(async (machine) => {
      const probe = machine.status === 'running'
        ? await probeCustomerVpsRelease(machine, platformSecret)
        : { reachable: false, error: 'VPS not running' };
      return {
        machineId: machine.machineId,
        handle: machine.handle,
        status: machine.status,
        publicIPv4: machine.publicIPv4,
        imageVersion: machine.imageVersion,
        lastSeenAt: machine.lastSeenAt,
        provisionedAt: machine.provisionedAt,
        release: probe,
      };
    }));
    return c.json({
      generatedAt: new Date().toISOString(),
      machines: rows,
    });
  });
  if (deps.customerVpsService) {
    async function probeMachineRuntime(machine: { machineId: string; handle: string; publicIPv4: string | null }) {
      return probeCustomerVpsRuntime(machine, platformSecret);
    }

    async function probeMachineHealth(machine: { machineId: string; handle: string; publicIPv4: string | null }): Promise<boolean> {
      if (!machine.publicIPv4) return false;
      const token = buildPlatformVerificationToken(machine.handle, platformSecret);
      try {
        const res = await fetch(`https://${machine.publicIPv4}:443/health`, {
          headers: { authorization: `Bearer ${token}` },
          dispatcher: customerVpsProxyDispatcher,
          signal: AbortSignal.timeout(8_000),
        } as RequestInit & { dispatcher: Agent });
        return res.ok;
      } catch (err: unknown) {
        console.warn(`[fleet-probe] health check failed for ${machine.handle}:`, err instanceof Error ? err.message : String(err));
        return false;
      }
    }

    app.route('/vps', createCustomerVpsRoutes({
      service: deps.customerVpsService,
      platformSecret,
      probeMachineHealth,
      probeMachineRuntime,
      recordRuntimeMetrics: (machines) => updateCachedVpsRuntimeMetrics(machines, machines),
    }));
  }

  app.route('/api/operator', createLaunchReadinessRoutes({
    service: createLaunchReadinessService({
      loadEvidence: createPlatformLaunchEvidenceLoader({ db, env: appEnv }),
    }),
    platformSecret,
  }));

  // Auth middleware for admin API routes below
  app.use('*', async (c, next) => {
    if (c.req.path === '/health') return next();
    if (c.req.path === '/metrics') return next();
    if (c.req.path.endsWith('/self-upgrade') && c.req.method === 'POST') return next();
    if (!platformSecret) {
      return c.json({ error: 'Platform admin not configured' }, 503);
    }
    const auth = c.req.header('authorization');
    if (!bearerTokenEquals(auth, platformSecret)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return next();
  });

  // --- Container management ---

  app.post('/containers/provision', bodyLimit({ maxSize: ADMIN_BODY_LIMIT }), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (e: unknown) {
      logPlatformRouteError('/containers/provision parse', e);
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const parsed = ProvisionBodySchema.safeParse(body);
    if (!parsed.success) {
      const data = body as { handle?: unknown; clerkUserId?: unknown } | null;
      if (!data || typeof data !== 'object' || data.handle === undefined || data.clerkUserId === undefined) {
        return c.json({ error: 'handle and clerkUserId required' }, 400);
      }
      if (typeof data.handle !== 'string' || !HANDLE_PATTERN.test(data.handle)) {
        return c.json({ error: 'Invalid handle' }, 400);
      }
      return c.json({ error: 'Validation error' }, 400);
    }

    const { handle, clerkUserId, displayName, runtimeSlot } = parsed.data;
    if (!handle || !clerkUserId) {
      return c.json({ error: 'handle and clerkUserId required' }, 400);
    }
    try {
      if (deps.customerVpsService) {
        const machine = await deps.customerVpsService.provision({ handle, clerkUserId, runtimeSlot });

        // Provision Matrix accounts (non-blocking: log error but don't fail VPS provision)
        if (matrixProvisioner) {
          try {
            await matrixProvisioner.provisionUser(handle);
          } catch (matrixErr) {
            console.error(`[matrix] Failed to provision Matrix accounts for ${handle}:`, matrixErr instanceof Error ? matrixErr.message : String(matrixErr));
          }
        }

        return c.json({
          runtime: 'customer_vps',
          handle,
          clerkUserId,
          ...machine,
          runtimeSlot,
        }, 202);
      }

      const record = await orchestrator.provision(handle, clerkUserId, displayName);

      // Provision Matrix accounts (non-blocking: log error but don't fail container provision)
      if (matrixProvisioner) {
        try {
          await matrixProvisioner.provisionUser(handle);
        } catch (matrixErr) {
          console.error(`[matrix] Failed to provision Matrix accounts for ${handle}:`, matrixErr instanceof Error ? matrixErr.message : String(matrixErr));
        }
      }

      return c.json(record, 201);
    } catch (e: unknown) {
      if (e instanceof Error && e.message.startsWith('Container already exists for handle:')) {
        return c.json({ error: 'Container already exists' }, 409);
      }
      if (e instanceof CustomerVpsError) {
        return c.json({ error: e.publicMessage }, e.status as never);
      }
      logPlatformRouteError('/containers/provision', e);
      return c.json({ error: 'Provision failed' }, 500);
    }
  });

  app.post('/containers/:handle/start', async (c) => {
    try {
      await orchestrator.start(requireValidHandle(c.req.param('handle')));
      return c.json({ ok: true });
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'Invalid handle') {
        return c.json({ error: 'Invalid handle' }, 400);
      }
      if (isMissingContainerError(e)) {
        return c.json({ error: 'Container not found' }, 404);
      }
      logPlatformRouteError('/containers/:handle/start', e);
      return c.json({ error: 'Failed to start container' }, 500);
    }
  });

  app.post('/containers/:handle/stop', async (c) => {
    try {
      await orchestrator.stop(requireValidHandle(c.req.param('handle')));
      return c.json({ ok: true });
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'Invalid handle') {
        return c.json({ error: 'Invalid handle' }, 400);
      }
      if (isMissingContainerError(e)) {
        return c.json({ error: 'Container not found' }, 404);
      }
      logPlatformRouteError('/containers/:handle/stop', e);
      return c.json({ error: 'Failed to stop container' }, 500);
    }
  });

  app.post('/containers/:handle/upgrade', async (c) => {
    try {
      const record = await orchestrator.upgrade(requireValidHandle(c.req.param('handle')));
      return c.json(record);
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'Invalid handle') {
        return c.json({ error: 'Invalid handle' }, 400);
      }
      if (isMissingContainerError(e)) {
        return c.json({ error: 'Container not found' }, 404);
      }
      logPlatformRouteError('/containers/:handle/upgrade', e);
      return c.json({ error: 'Upgrade failed' }, 500);
    }
  });

  app.post('/containers/:handle/self-upgrade', bodyLimit({ maxSize: ADMIN_BODY_LIMIT }), async (c) => {
    if (!platformSecret) {
      return c.json({ error: 'Self-upgrade not configured' }, 503);
    }
    let handle: string;
    try {
      handle = requireValidHandle(c.req.param('handle'));
    } catch (err: unknown) {
      if (!(err instanceof Error && err.message === 'Invalid handle')) {
        console.error('[platform] Unexpected self-upgrade handle validation failure:', err);
      }
      return c.json({ error: 'Invalid handle' }, 400);
    }
    const auth = c.req.header('authorization');
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';

    const expected = buildPlatformVerificationToken(handle, platformSecret);
    if (!timingSafeTokenEquals(token, expected)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    try {
      const record = await orchestrator.upgrade(handle);
      return c.json(record);
    } catch (e: unknown) {
      logPlatformRouteError('/containers/:handle/self-upgrade', e);
      return c.json({ error: 'Upgrade failed' }, 500);
    }
  });

  app.post('/containers/rolling-restart', async (c) => {
    const result = await orchestrator.rollingRestart();
    return c.json(result);
  });

  app.delete('/containers/:handle', async (c) => {
    try {
      await orchestrator.destroy(requireValidHandle(c.req.param('handle')));
      return c.json({ ok: true });
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'Invalid handle') {
        return c.json({ error: 'Invalid handle' }, 400);
      }
      if (isMissingContainerError(e)) {
        return c.json({ error: 'Container not found' }, 404);
      }
      logPlatformRouteError('/containers/:handle', e);
      return c.json({ error: 'Failed to destroy container' }, 500);
    }
  });

  app.get('/containers', async (c) => {
    await orchestrator.syncStates();
    const status = c.req.query('status');
    return c.json(await orchestrator.listAll(status));
  });

  app.get('/containers/:handle', async (c) => {
    const info = await orchestrator.getInfo(c.req.param('handle'));
    if (!info) return c.json({ error: 'Not found' }, 404);
    return c.json({ ...info, image: orchestrator.getImage() });
  });

  app.get('/containers/check-handle/:handle', async (c) => {
    const info = await orchestrator.getInfo(c.req.param('handle'));
    if (!info) return c.json({ error: 'Not found' }, 404);
    return c.json({ exists: true, status: info.status });
  });

  // --- Admin dashboard ---

  app.get('/admin/dashboard', async (c) => {
    await orchestrator.syncStates();
    const all = await orchestrator.listAll();
    const running = all.filter((r) => r.status === 'running');
    const stopped = all.filter((r) => r.status !== 'running');

    const containerResults = await Promise.all(
      running.map(async (r) => {
        const base = `http://matrixos-${r.handle}:4000`;
        const timeout = 3000;

        const fetchJson = async (url: string, label: string) => {
          try {
            const res = await fetch(url, {
              signal: AbortSignal.timeout(timeout),
            });
            if (!res.ok) {
              console.warn(`[platform] ${label} returned ${res.status}`);
              return null;
            }
            return await res.json();
          } catch (err: unknown) {
            console.warn(
              `[platform] ${label} failed:`,
              err instanceof Error ? err.message : String(err),
            );
            return null;
          }
        };

        const [health, systemInfo, conversations] = await Promise.all([
          fetchJson(`${base}/health`, `${r.handle} health check`),
          fetchJson(`${base}/api/system/info`, `${r.handle} system info`),
          fetchJson(`${base}/api/conversations`, `${r.handle} conversations`),
        ]);

        return {
          handle: r.handle,
          status: r.status,
          lastActive: r.lastActive,
          health,
          systemInfo,
          conversationCount: Array.isArray(conversations) ? conversations.length : null,
        };
      }),
    );

    let usageSummary = null;
    try {
      const res = await fetch('http://proxy:8080/usage/summary', {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) usageSummary = await res.json();
      else console.warn(`[platform] usage summary returned ${res.status}`);
    } catch (err: unknown) {
      console.warn(
        '[platform] usage summary fetch failed:',
        err instanceof Error ? err.message : String(err),
      );
    }

    return c.json({
      timestamp: new Date().toISOString(),
      summary: {
        total: all.length,
        running: running.length,
        stopped: stopped.length,
      },
      containers: containerResults,
      stoppedContainers: stopped.map((r) => ({
        handle: r.handle,
        status: r.status,
        lastActive: r.lastActive,
      })),
      usageSummary,
    });
  });

  // --- Store API (public, no auth) ---

  app.route('/api/store', createStoreApi(db));

  // --- Social Feed API (public) ---

  const socialFeedApi = createSocialFeedApi(db);
  posthogShutdowns.push(() => socialFeedApi.shutdownPostHog());
  app.route('/api/social', socialFeedApi);

  // --- Social API (legacy: container-level profiles/messaging) ---

  const social = createSocialApi(db);

  app.get('/social/users', async (c) => {
    return c.json(await social.listUsers());
  });

  app.get('/social/profiles/:handle', async (c) => {
    const profile = await social.getProfile(c.req.param('handle'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    return c.json(profile);
  });

  app.get('/social/profiles/:handle/ai', async (c) => {
    const profile = await social.getAiProfile(c.req.param('handle'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    return c.json(profile);
  });

  app.post('/social/send/:handle', bodyLimit({ maxSize: ADMIN_BODY_LIMIT }), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (e: unknown) {
      logPlatformRouteError('/social/send/:handle parse', e);
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const parsed = SocialSendBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Validation error' }, 400);
    }

    const { text, from } = parsed.data;
    try {
      const result = await social.sendMessage(c.req.param('handle'), text, from);
      return c.json(result);
    } catch (e: unknown) {
      logPlatformRouteError('/social/send/:handle', e);
      return c.json({ error: 'Message delivery failed' }, 404);
    }
  });

  // --- Subdomain proxy ---

  app.all('/proxy/:handle/*', bodyLimit({ maxSize: PROXY_BODY_LIMIT }), async (c) => {
    const handle = c.req.param('handle');
    if (!HANDLE_PATTERN.test(handle)) {
      return c.json({ error: 'Invalid handle' }, 400);
    }
    const path = c.req.path.replace(`/proxy/${handle}`, '') || '/';
    const qs = buildForwardedQueryString(c.req.url);
    const runningMachine = await getRunningUserMachineByHandle(db, handle);
    if (runningMachine) {
      const targetUrl = buildCustomerVpsProxyUrl(runningMachine, path, qs);
      if (!targetUrl) {
        return c.json({ error: 'VPS unreachable' }, 502);
      }
      try {
        const headers = new Headers();
        const originalHost = c.req.header('host') ?? `${handle}.matrix-os.com`;
        for (const [key, value] of Object.entries(c.req.header())) {
          const lowerKey = key.toLowerCase();
          if (lowerKey !== 'host' && !SENSITIVE_PROXY_HEADERS.has(lowerKey) && value) headers.set(key, value);
        }
        headers.set('host', `${handle}.matrix-os.com`);
        headers.set('x-forwarded-host', originalHost);
        headers.set('x-forwarded-proto', 'https');
        headers.set('accept-encoding', 'identity');

        const upstream = await fetch(targetUrl, {
          method: c.req.method,
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
          body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.blob(),
          dispatcher: customerVpsProxyDispatcher,
        } as RequestInit & { dispatcher: Agent });

        return new Response(upstream.body, {
          status: upstream.status,
          headers: sanitizeProxyResponseHeaders(upstream.headers),
        });
      } catch (err: unknown) {
        logPlatformRouteError('/proxy/:handle/* vps', err);
        return c.json({ error: 'VPS unreachable' }, 502);
      }
    }

    const record = await getContainer(db, handle);
    if (!record) return c.json({ error: 'Unknown handle' }, 404);

    if (record.status === 'stopped') {
      try {
        await orchestrator.start(handle);
      } catch (err: unknown) {
        logPlatformRouteError('/proxy/:handle/* start', err);
        return c.json({ error: 'Failed to wake container' }, 503);
      }
    }

    await updateLastActive(db, handle);

    const targetUrl = `http://matrixos-${handle}:3000${path}`;

    try {
      const headers = new Headers();
      const originalHost = c.req.header('host') ?? '';
      for (const [key, value] of Object.entries(c.req.header())) {
        const lowerKey = key.toLowerCase();
        if (lowerKey !== 'host' && !SENSITIVE_PROXY_HEADERS.has(lowerKey) && value) headers.set(key, value);
      }
      headers.set('x-forwarded-host', originalHost);
      headers.set('x-forwarded-proto', 'https');
      headers.set('accept-encoding', 'identity');

      const upstream = await fetch(targetUrl, {
        method: c.req.method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
        body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.blob(),
      });

      return new Response(upstream.body, {
        status: upstream.status,
        headers: sanitizeProxyResponseHeaders(upstream.headers),
      });
    } catch (err: unknown) {
      logPlatformRouteError('/proxy/:handle/*', err);
      return c.json({ error: 'Container unreachable' }, 502);
    }
  });

  app.shutdownPostHog = async () => {
    await Promise.allSettled(posthogShutdowns.map((shutdownPostHog) => shutdownPostHog()));
  };

  return app;
}

// Start server when run directly
if (process.argv[1]?.endsWith('main.ts') || process.argv[1]?.endsWith('main.js')) {
  if (checkUnsafeDefaultSecrets().length > 0) {
    process.exit(1);
  }
  const platformDatabaseUrl = process.env.PLATFORM_DATABASE_URL ??
    (process.env.POSTGRES_URL ? `${process.env.POSTGRES_URL}/matrixos_platform` : undefined);
  const db = platformDatabaseUrl ? createPlatformDb(platformDatabaseUrl) : createPlatformDb();
  await db.ready;
  const docker = new Dockerode();

  checkHomeMirrorS3Env();

  const [{ createOrchestrator }, { createLifecycleManager }] = await Promise.all([
    import('./orchestrator.js'),
    import('./lifecycle.js'),
  ]);
  const orchestrator = createOrchestrator({
    db,
    docker,
    image: process.env.PLATFORM_IMAGE,
    dataDir: process.env.PLATFORM_DATA_DIR,
    platformSecret: PLATFORM_SECRET,
    publicTelemetryEnv: collectTenantPublicTelemetryEnv(),
    postgresUrl: process.env.POSTGRES_URL,
  });

  const maxRunning = Number(process.env.MAX_RUNNING_CONTAINERS) || 20;
  const lifecycle = createLifecycleManager({ db, orchestrator, maxRunning });
  lifecycle.start();

  const { createStatsCollector } = await import('./stats-collector.js');
  const statsCollector = createStatsCollector({
    docker,
    listRunning: () => listContainers(db, 'running'),
    onResolvedContainerId: async (handle, containerId) => {
      await updateContainerStatus(db, handle, 'running', containerId);
    },
  });
  statsCollector.start();

  // Clerk JWT verification (optional -- only active when CLERK_SECRET_KEY is set)
  let clerkAuth: ClerkAuth | undefined;
  if (process.env.CLERK_SECRET_KEY) {
    const { verifyToken } = await import('@clerk/backend');
    clerkAuth = createClerkAuth({
      verifyToken: async (token: string) => {
        const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY! });
        return payload as { sub: string; [key: string]: unknown };
      },
    });
  }

  // Matrix provisioner (optional: only if Conduit URL is configured)
  let matrixProvisioner: MatrixProvisioner | undefined;
  const conduitUrl = process.env.MATRIX_CONDUIT_URL;
  const conduitToken = process.env.CONDUIT_REGISTRATION_TOKEN;
  if (conduitUrl && !conduitToken) {
    console.error('[platform] CONDUIT_REGISTRATION_TOKEN is required when MATRIX_CONDUIT_URL is set');
    process.exit(1);
  }
  if (conduitUrl) {
    const { createMatrixProvisioner } = await import('./matrix-provisioning.js');
    matrixProvisioner = createMatrixProvisioner({
      db,
      homeserverUrl: conduitUrl,
      registrationToken: conduitToken!,
    });
    console.log(`[matrix] Provisioner enabled (${conduitUrl})`);
  }

  let integrationRoutes: Hono | undefined;
  let internalIntegrationRoutes: Hono | undefined;
  if (
    process.env.POSTGRES_URL &&
    process.env.PIPEDREAM_CLIENT_ID &&
    process.env.PIPEDREAM_CLIENT_SECRET &&
    process.env.PIPEDREAM_PROJECT_ID
  ) {
    const [
      { createIntegrationRoutes },
      { createPipedreamClient },
      { createPlatformDb: createGatewayPlatformDb },
    ] = await Promise.all([
      importRuntimeModule<GatewayIntegrationRoutesModule>('../../gateway/src/integrations/routes.js'),
      importRuntimeModule<GatewayPipedreamModule>('../../gateway/src/integrations/pipedream.js'),
      importRuntimeModule<GatewayPlatformDbModule>('../../gateway/src/platform-db.js'),
    ]);

    const trustedPlatformDb = createGatewayPlatformDb(`${process.env.POSTGRES_URL}/matrixos_platform`);
    await trustedPlatformDb.migrate();
    const pipedream = await createPipedreamClient({
      clientId: process.env.PIPEDREAM_CLIENT_ID,
      clientSecret: process.env.PIPEDREAM_CLIENT_SECRET,
      projectId: process.env.PIPEDREAM_PROJECT_ID,
      environment: process.env.PIPEDREAM_ENVIRONMENT ?? 'production',
    });
    const webhookSecret = process.env.PIPEDREAM_WEBHOOK_SECRET ?? '';
    const resolveIntegrationUserId = async (clerkUserId: string | undefined, handle: string | undefined) => {
      if (!clerkUserId) return null;
      const existing = await trustedPlatformDb!.getUserByClerkId(clerkUserId);
      if (existing) return existing.id;
      if (!handle) return null;

      const owner =
        (await getRunningUserMachineByHandle(db, handle)) ??
        (await getContainer(db, handle));
      if (!owner || owner.clerkUserId !== clerkUserId) {
        return null;
      }

      const user = await trustedPlatformDb!.ensureUser({
        clerkId: clerkUserId,
        handle,
        displayName: handle,
        email: `${handle}@matrix-os.local`,
        containerId: `platform:${clerkUserId}`,
      });
      return user.id;
    };

    integrationRoutes = createIntegrationRoutes({
      db: trustedPlatformDb,
      pipedream,
      webhookSecret,
      resolveUserId: async (c) => {
        const clerkUserId = c.get('platformUserId') as string | undefined;
        const handle = c.get('platformHandle') as string | undefined;
        return await resolveIntegrationUserId(clerkUserId, handle);
      },
    });
    internalIntegrationRoutes = createIntegrationRoutes({
      db: trustedPlatformDb,
      pipedream,
      webhookSecret,
      resolveUserId: async (c) => {
        const clerkUserId = c.get('internalContainerClerkUserId') as string | undefined;
        const handle = c.get('internalContainerHandle') as string | undefined;
        return await resolveIntegrationUserId(clerkUserId, handle);
      },
    });
  }

  let internalSyncRoutes: Hono | undefined;
  let customerVpsObjectStore:
    | {
        putObject(
          key: string,
          body: string | Uint8Array | ReadableStream<Uint8Array>,
          options?: { signal?: AbortSignal },
        ): Promise<{ etag?: string }>;
        getObject(
          key: string,
          options?: { signal?: AbortSignal },
        ): Promise<{ body: ReadableStream | null; etag?: string; contentLength?: number }>;
      }
    | undefined;
  const s3Endpoint = process.env.S3_ENDPOINT ?? process.env.R2_ENDPOINT;
  const s3AccessKey = process.env.S3_ACCESS_KEY_ID ?? process.env.R2_ACCESS_KEY_ID;
  const s3SecretKey = process.env.S3_SECRET_ACCESS_KEY ?? process.env.R2_SECRET_ACCESS_KEY;
  const s3Bucket = process.env.S3_BUCKET ?? process.env.R2_BUCKET ?? 'matrixos-sync';
  const s3ForcePathStyle = process.env.S3_FORCE_PATH_STYLE === 'true';
  if (s3AccessKey && s3SecretKey && PLATFORM_SECRET) {
    const [{ createR2Client }, { createInternalSyncRoutes }] = await Promise.all([
      importRuntimeModule<GatewayR2ClientModule>('../../gateway/src/sync/r2-client.js'),
      import('./internal-sync-routes.js'),
    ]);
    const r2 = await createR2Client({
      accessKeyId: s3AccessKey,
      secretAccessKey: s3SecretKey,
      bucket: s3Bucket,
      endpoint: s3Endpoint,
      publicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? process.env.R2_PUBLIC_ENDPOINT,
      accountId: process.env.R2_ACCOUNT_ID,
      forcePathStyle: s3ForcePathStyle,
    });
    internalSyncRoutes = createInternalSyncRoutes({
      db,
      r2,
      platformSecret: PLATFORM_SECRET,
    });
    customerVpsObjectStore = r2;
  }

  let customerVpsService: CustomerVpsService | undefined;
  let customerVpsReconciliationInterval: ReturnType<typeof setInterval> | undefined;
  let customerVpsReconciliationPromise: Promise<void> | undefined;
  if (process.env.CUSTOMER_VPS_ENABLED === 'true') {
    const [
      { createCustomerVpsService },
      { loadCustomerVpsConfig },
      { createHetznerClient },
      { createCustomerVpsSystemStore, createNoopCustomerVpsSystemStore },
      { loadCustomerVpsCloudInitTemplate },
    ] = await Promise.all([
      import('./customer-vps.js'),
      import('./customer-vps-config.js'),
      import('./customer-vps-hetzner.js'),
      import('./customer-vps-r2.js'),
      import('./customer-vps-cloud-init.js'),
    ]);
    const customerVpsConfig = loadCustomerVpsConfig();
    const cloudInitTemplate = await loadCustomerVpsCloudInitTemplate();
    customerVpsService = createCustomerVpsService({
      db,
      config: customerVpsConfig,
      hetzner: createHetznerClient(customerVpsConfig),
      systemStore: customerVpsObjectStore
        ? createCustomerVpsSystemStore({
            r2: customerVpsObjectStore,
            r2PrefixRoot: customerVpsConfig.r2PrefixRoot,
          })
        : createNoopCustomerVpsSystemStore(),
      cloudInitTemplate,
      fetchDispatcher: customerVpsProxyDispatcher,
    });
    const reconciliationIntervalMs = Number(process.env.CUSTOMER_VPS_RECONCILIATION_INTERVAL_MS ?? 60_000);
    if (reconciliationIntervalMs > 0) {
      // Customer VPS reconciliation currently assumes one active platform
      // process. If the platform is horizontally scaled, replace this
      // in-process guard with a DB advisory lock before enabling the interval
      // on multiple instances.
      let reconciliationRunning = false;
      const runCustomerVpsReconciliation = async () => {
        if (reconciliationRunning || !customerVpsService) return;
        reconciliationRunning = true;
        customerVpsReconciliationPromise = (async () => {
          try {
            const result = await customerVpsService!.reconcileProvisioning();
            if (result.checked > 0) {
              console.log(
                `[platform] customer VPS reconciliation checked=${result.checked} running=${result.running} failed=${result.failed}`,
              );
            }
          } catch (err: unknown) {
            logPlatformRouteError('customer VPS reconciliation', err);
          } finally {
            reconciliationRunning = false;
            customerVpsReconciliationPromise = undefined;
          }
        })();
        await customerVpsReconciliationPromise;
      };
      void runCustomerVpsReconciliation();
      customerVpsReconciliationInterval = setInterval(runCustomerVpsReconciliation, reconciliationIntervalMs);
      customerVpsReconciliationInterval.unref();
    }
  }

  const appEnv = process.env;
  const app = createApp({
    db,
    docker,
    orchestrator,
    clerkAuth,
    matrixProvisioner,
    integrationRoutes,
    internalIntegrationRoutes,
    internalSyncRoutes,
    customerVpsService,
    customerVpsObjectStore,
  });

  const server = serve({ fetch: app.fetch, port: PORT }, () => {
    console.log(`Platform listening on :${PORT}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[platform] Received ${signal}, shutting down`);
    if (customerVpsReconciliationInterval) {
      clearInterval(customerVpsReconciliationInterval);
    }
    const shutdownTimer = setTimeout(() => {
      console.error('[platform] Graceful shutdown timed out');
      process.exit(1);
    }, 10_000);
    shutdownTimer.unref();

    (server as Server).close((err?: Error) => {
      let exitCode = 0;
      if (err) {
        exitCode = 1;
        console.error('[platform] HTTP server close failed:', err.message);
      }
      (async () => {
        if (customerVpsReconciliationPromise) {
          await customerVpsReconciliationPromise;
        }
        await Promise.allSettled([
          containerProxyDispatcher.close(),
          customerVpsProxyDispatcher.close(),
        ]);
        await app.shutdownPostHog();
        await db.destroy();
      })()
        .catch((destroyErr: unknown) => {
          exitCode = 1;
          console.error(
            '[platform] Shutdown cleanup failed:',
            destroyErr instanceof Error ? destroyErr.message : String(destroyErr),
          );
        })
        .finally(() => {
          clearTimeout(shutdownTimer);
          process.exit(exitCode);
        });
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  // WebSocket upgrade handler
  (server as import('node:http').Server).on('upgrade', async (req: IncomingMessage, socket, head) => {
    try {
      const handledInternalGeminiLive = await handleInternalGeminiLiveProxyUpgrade({
        req,
        socket: socket as Socket,
        head,
        db,
        platformSecret: PLATFORM_SECRET,
        geminiApiKey: process.env.GEMINI_API_KEY ?? '',
      });
      if (handledInternalGeminiLive) return;
    } catch (err: unknown) {
      console.warn('[platform] internal Gemini Live proxy failed:', describeError(err));
      app.capturePlatformEvent(MATRIX_TELEMETRY_EVENTS.PLATFORM_WS_UPSTREAM_FAILED, {
        pathClass: 'internal-gemini-live',
        errorKind: err instanceof Error ? err.name : typeof err,
      });
      socket.destroy();
      return;
    }

    const path = req.url ?? '/';
    const pathClass = classifyWebSocketPath(path);
    const host = getSessionRoutedWebSocketHost(req.headers.host, req.headers['x-forwarded-host'], path);
    if (!isSessionRoutedHost(host)) {
      socket.destroy();
      return;
    }
    const isCodeDomain = isCodeDomainHost(host);
    const hostClass = classifySessionRoutedHost(host);

    const requestRuntimeSlot = readRuntimeSlot(path);
    const wsToken = getWebSocketUpgradeToken(path);
    let identity: AppDomainIdentity | null;
    try {
      identity = await resolveAppDomainIdentity({
        authHeader: req.headers.authorization as string | undefined,
        cookieHeader: req.headers.cookie,
        clerkAuth,
        db,
        platformJwtSecret: PLATFORM_JWT_SECRET,
        runtimeSlot: requestRuntimeSlot,
        wsToken,
      });
    } catch (err: unknown) {
      console.warn(
        `[platform] websocket auth failed host=${host} pathClass=${pathClass} error=${describeError(err)}`,
      );
      app.capturePlatformEvent(MATRIX_TELEMETRY_EVENTS.PLATFORM_WS_AUTH_FAILED, {
        hostClass,
        pathClass,
        runtimeSlot: requestRuntimeSlot,
        hasToken: Boolean(wsToken),
        hasCookie: Boolean(req.headers.cookie),
        errorKind: err instanceof Error ? err.name : typeof err,
      });
      socket.destroy();
      return;
    }
    if (!identity) {
      console.warn(`[platform] websocket unauthenticated host=${host} pathClass=${pathClass} hasCookie=${Boolean(req.headers.cookie)} hasToken=${Boolean(wsToken)}`);
      app.capturePlatformEvent(MATRIX_TELEMETRY_EVENTS.PLATFORM_WS_UNAUTHENTICATED, {
        hostClass,
        pathClass,
        runtimeSlot: requestRuntimeSlot,
        hasToken: Boolean(wsToken),
        hasCookie: Boolean(req.headers.cookie),
      });
      socket.destroy();
      return;
    }

    let runtimeSlot = identity.runtimeSlot ?? requestRuntimeSlot;
    let requestedActiveMachine: UserMachineRecord | undefined;
    let runningMachine = identity.userId
      ? await getRunningUserMachineByClerkId(db, identity.userId, runtimeSlot)
      : await getRunningUserMachineByHandle(db, identity.handle);
    if (!runningMachine && identity.userId) {
      requestedActiveMachine = await getActiveUserMachineByClerkId(db, identity.userId, runtimeSlot);
      if (!requestedActiveMachine) {
        const handleMachine = await getRunningUserMachineByHandle(db, identity.handle);
        if (handleMachine?.clerkUserId === identity.userId) {
          runningMachine = handleMachine;
        }
      }
    }
    if (runningMachine) {
      runtimeSlot = runningMachine.runtimeSlot;
    }
    const record = await getContainer(db, identity.handle);
    if (!runningMachine && !record) { socket.destroy(); return; }
    const entitlement = getRuntimeEntitlementDecision(appEnv);
    let activeUpstream: Socket | null = null;
    const onSocketError = () => activeUpstream?.destroy();
    socket.on('error', onSocketError);

    const buildUpgradeHeaders = (handle: string, includePlatformProof: boolean): string => (
      buildPlatformWebSocketUpgradeHeaders({
        incomingHeaders: req.headers,
        externalHost: host,
        handle,
        userId: identity.userId,
        platformSecret: PLATFORM_SECRET,
        includePlatformProof,
        isCodeDomain,
      })
    );

    const writeUpgradeRequest = (
      upstream: Socket,
      upstreamHostHeader: string,
      headers: string,
    ): void => {
      if (!isSafeWebSocketUpgradePath(path)) {
        socket.destroy();
        upstream.destroy();
        return;
      }
      const upstreamPath = stripWebSocketUpgradeToken(path);
      upstream.write(
        `${req.method} ${upstreamPath} HTTP/1.1\r\nHost: ${upstreamHostHeader}\r\n${headers}\r\n\r\n`
      );
      if (head.length > 0) upstream.write(head);

      upstream.pipe(socket);
      socket.pipe(upstream);
    };

    if (runningMachine) {
      if (!entitlement.runtimeProxyAllowed) {
        console.warn(
          `[platform] websocket runtime proxy denied by entitlement handle=${runningMachine.handle} pathClass=${pathClass}`,
        );
        app.capturePlatformEvent(MATRIX_TELEMETRY_EVENTS.PLATFORM_WS_ENTITLEMENT_DENIED, {
          handle: runningMachine.handle,
          runtimeSlot,
          pathClass,
        });
        socket.destroy();
        return;
      }
      if (!runningMachine.publicIPv4) {
        console.warn(
          `[platform] websocket runtime proxy missing upstream address handle=${runningMachine.handle} pathClass=${pathClass}`,
        );
        socket.destroy();
        return;
      }
      const upstreamHostHeader = isCodeDomain ? host : 'app.matrix-os.com';
      const headers = buildUpgradeHeaders(runningMachine.handle, true);
      const upstreamServerName = upstreamHostHeader.split(':')[0] ?? upstreamHostHeader;
      const upstream = createTlsConnection({
        host: runningMachine.publicIPv4,
        port: 443,
        servername: upstreamServerName,
        rejectUnauthorized: shouldVerifyCustomerVpsTls(),
      }, () => {
        activeUpstream = upstream;
        writeUpgradeRequest(upstream, upstreamHostHeader, headers);
      });
      upstream.on('error', (err) => {
        upstream.destroy();
        console.warn(
          `[platform] websocket vps upstream failed handle=${runningMachine.handle} host=${runningMachine.publicIPv4} pathClass=${pathClass} error=${describeError(err)}`,
        );
        app.capturePlatformEvent(MATRIX_TELEMETRY_EVENTS.PLATFORM_WS_UPSTREAM_FAILED, {
          handle: runningMachine.handle,
          runtimeSlot,
          pathClass,
          errorKind: err instanceof Error ? err.name : typeof err,
        });
        socket.destroy();
      });
      return;
    }

    if (!record) { socket.destroy(); return; }
    if (!entitlement.runtimeProxyAllowed) {
      console.warn(
        `[platform] websocket legacy container proxy denied by entitlement handle=${record.handle} pathClass=${pathClass}`,
      );
      socket.destroy();
      return;
    }
    const connectUpstream = async (attempt: number): Promise<void> => {
      const endpoint = await resolveContainerEndpoint(docker, db, record.handle, record.containerId);
      if (!endpoint) {
        console.warn(
          `[platform] websocket upstream unresolved handle=${record.handle} attempt=${attempt + 1} pathClass=${pathClass}`,
        );
        socket.destroy();
        return;
      }

      let connected = false;
      const targetPort = isCodeDomain ? CODE_SERVER_PORT : 4000;
      const upstream = createConnection({ host: endpoint.host, port: targetPort }, () => {
        connected = true;
        activeUpstream = upstream;
        const upstreamHostHeader = isCodeDomain ? host : `${endpoint.host}:${targetPort}`;
        writeUpgradeRequest(
          upstream,
          upstreamHostHeader,
          buildUpgradeHeaders(record.handle, !isCodeDomain),
        );
      });

      upstream.on('error', (err) => {
        upstream.destroy();
        console.warn(
          `[platform] websocket upstream failed handle=${record.handle} attempt=${attempt + 1} host=${endpoint.host} source=${endpoint.source} containerId=${endpoint.containerId ?? 'null'} pathClass=${pathClass} error=${describeError(err)}`,
        );
        if (!connected && attempt === 0 && !socket.destroyed) {
          void connectUpstream(attempt + 1).catch((retryErr) => {
            console.error('[platform] websocket upstream retry fatal error:', describeError(retryErr));
            socket.destroy();
          });
          return;
        }
        socket.destroy();
      });
    };

    void connectUpstream(0).catch((err) => {
      console.error('[platform] websocket upstream fatal error:', describeError(err));
      socket.destroy();
    });
  });
}
