import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SiteAccessLinkSecretSchema, SiteIdSchema, SITE_VIEWER_SESSION_TTL_MS } from '@matrix-os/contracts';

const VIEWER_COOKIE_PREFIX = '__Secure-matrix_site_viewer_';
const ASSET_COOKIE_PREFIX = '__Secure-matrix_site_asset_';
const COOKIE_HEADER_MAX_BYTES = 8 * 1024;

export function createSiteAccessSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSiteAccessSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function siteAccessSecretMatches(secret: string, expectedHash: string): boolean {
  if (!SiteAccessLinkSecretSchema.safeParse(secret).success || !/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  const actual = Buffer.from(hashSiteAccessSecret(secret), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function siteViewerCookieName(siteId: string): string {
  return `${VIEWER_COOKIE_PREFIX}${SiteIdSchema.parse(siteId).replaceAll('-', '')}`;
}

export function siteAssetCookieName(siteId: string): string {
  return `${ASSET_COOKIE_PREFIX}${SiteIdSchema.parse(siteId).replaceAll('-', '')}`;
}

export function buildSiteViewerCookie(siteId: string, linkId: string, secret: string): string {
  SiteIdSchema.parse(linkId);
  SiteAccessLinkSecretSchema.parse(secret);
  return [
    `${siteViewerCookieName(siteId)}=${linkId}.${secret}`,
    `Path=/${SiteIdSchema.parse(siteId)}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SITE_VIEWER_SESSION_TTL_MS / 1000)}`,
  ].join('; ');
}

export function buildSiteAssetCookie(siteId: string, linkId: string, secret: string): string {
  SiteIdSchema.parse(linkId);
  SiteAccessLinkSecretSchema.parse(secret);
  return [
    `${siteAssetCookieName(siteId)}=${linkId}.${secret}`,
    `Path=/${SiteIdSchema.parse(siteId)}/assets/`,
    'HttpOnly',
    'Secure',
    'SameSite=None',
    `Max-Age=${Math.floor(SITE_VIEWER_SESSION_TTL_MS / 1000)}`,
  ].join('; ');
}

export function readSiteViewerCookie(cookieHeader: string | undefined, siteId: string): { linkId: string; token: string } | null {
  return readSiteCookie(cookieHeader, siteViewerCookieName(siteId));
}

export function readSiteAssetCookie(cookieHeader: string | undefined, siteId: string): { linkId: string; token: string } | null {
  return readSiteCookie(cookieHeader, siteAssetCookieName(siteId));
}

function readSiteCookie(cookieHeader: string | undefined, name: string): { linkId: string; token: string } | null {
  if (!cookieHeader || Buffer.byteLength(cookieHeader) > COOKIE_HEADER_MAX_BYTES) return null;
  const entry = cookieHeader.split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`));
  if (!entry) return null;
  const value = entry.slice(name.length + 1);
  const separator = value.indexOf('.');
  if (separator < 1 || value.indexOf('.', separator + 1) !== -1) return null;
  const linkId = value.slice(0, separator);
  const token = value.slice(separator + 1);
  return SiteIdSchema.safeParse(linkId).success && SiteAccessLinkSecretSchema.safeParse(token).success ? { linkId, token } : null;
}

export const SITE_VIEWER_COOKIE_PREFIX = VIEWER_COOKIE_PREFIX;
export const SITE_ASSET_COOKIE_PREFIX = ASSET_COOKIE_PREFIX;
