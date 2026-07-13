import { createHmac } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import {
  getSessionRoutedWebSocketHost,
  getWebSocketUpgradeHost,
  isAppDomainHost,
  isCodeDomainHost,
} from './ws-upgrade.js';
import {
  buildPlatformVerificationToken,
  timingSafeTokenEquals,
} from './platform-token.js';

type HeaderValue = string | string[] | undefined;

function firstHeaderValue(value: HeaderValue): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export function getTrustedSessionRouteHost(
  host: HeaderValue,
  forwardedHost: HeaderValue,
  edgeSecretHeader: HeaderValue,
  edgeRouterSecret: string | undefined,
): string {
  const rawHost = getWebSocketUpgradeHost(host, undefined);
  const normalizedForwardedHost = getWebSocketUpgradeHost(undefined, forwardedHost);
  if (!normalizedForwardedHost) return rawHost;

  const normalizedSecret = edgeRouterSecret?.trim();
  if (!normalizedSecret) return rawHost;
  if (!timingSafeTokenEquals(firstHeaderValue(edgeSecretHeader), normalizedSecret)) return rawHost;

  return normalizedForwardedHost;
}

export function getTrustedSessionRoutedWebSocketHost(
  host: HeaderValue,
  forwardedHost: HeaderValue,
  edgeSecretHeader: HeaderValue,
  edgeRouterSecret: string | undefined,
  path: string,
): string {
  const trustedHost = getTrustedSessionRouteHost(host, forwardedHost, edgeSecretHeader, edgeRouterSecret);
  return getSessionRoutedWebSocketHost(trustedHost, undefined, path);
}

export function buildPlatformUserProof(handle: string, userId: string, platformSecret: string): string {
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
