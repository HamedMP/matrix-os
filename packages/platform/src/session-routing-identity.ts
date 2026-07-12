import type { ClerkAuth } from './clerk-auth.js';
import {
  type PlatformDB,
  getActiveUserMachineByClerkId,
  getActiveUserMachineByHandle,
  getContainer,
  getContainerByClerkId,
  getRunningUserMachineByHandle,
} from './db.js';
import { verifySyncJwt } from './sync-jwt.js';
import { isAppDomainGatewayPath } from './request-routing.js';
import { RuntimeSlotSchema } from './customer-vps-schema.js';
import {
  APP_ROUTE_COOKIE,
  APP_SESSION_COOKIE,
  CODE_SESSION_COOKIE,
  NATIVE_APP_SESSION_COOKIE,
  SHELL_ROUTE_COOKIE,
  SHELL_RUNTIME_SLOT_COOKIE,
  isValidNativeAppSessionProof,
  readCookie,
} from './session-cookies.js';
import { HANDLE_PATTERN } from './platform-route-utils.js';
import {
  isAppDomainStaticAssetPath,
} from './session-routing-proxy.js';

export interface ExplicitVmRoute {
  handle: string;
  upstreamPath: string;
}

const NATIVE_APP_STREAM_PATH = /^\/api\/native-apps\/sessions\/session_[A-Za-z0-9_-]{24,96}\/stream(?:\/|$)/;
const NATIVE_APP_STREAM_CAPABILITY_PATH = /^\/api\/native-apps\/sessions\/session_[A-Za-z0-9_-]{24,96}\/stream\/stream_[A-Za-z0-9_-]{24,96}(?:\/|$)/;

export interface AppDomainIdentity {
  handle: string;
  userId: string;
  runtimeSlot?: string;
  source?: 'auth' | 'mobile-session' | 'static-route';
}

export interface SyncBearerIdentity {
  handle: string;
  userId: string;
  runtimeSlot?: string;
  expiresAt: number;
}

export function readMobileAppSessionRoutingHandle(path: string, rawUrl: string): string | null {
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

export function readMobileAppRouteCookie(path: string, cookieHeader: string | undefined): string | null {
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

export function buildAppRouteCookie(handle: string, path: string): string | null {
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

export function readShellRouteCookie(path: string, cookieHeader: string | undefined): string | null {
  if (!isAppDomainStaticAssetPath(path)) {
    return null;
  }
  const handle = readCookie(cookieHeader, SHELL_ROUTE_COOKIE);
  return handle && HANDLE_PATTERN.test(handle) ? handle : null;
}

export function buildShellRouteCookie(handle: string): string {
  return [
    `${SHELL_ROUTE_COOKIE}=${encodeURIComponent(handle)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=600',
  ].join('; ');
}

export function buildShellRuntimeSlotCookie(runtimeSlot: string): string {
  return [
    `${SHELL_RUNTIME_SLOT_COOKIE}=${encodeURIComponent(runtimeSlot)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=600',
  ].join('; ');
}

export function readShellRuntimeSlotCookie(path: string, cookieHeader: string | undefined): string | null {
  if (!isAppDomainGatewayPath(path) && !isAppDomainStaticAssetPath(path)) {
    return null;
  }
  const runtimeSlot = readCookie(cookieHeader, SHELL_RUNTIME_SLOT_COOKIE);
  const parsed = RuntimeSlotSchema.safeParse(runtimeSlot);
  return parsed.success ? parsed.data : null;
}

export function readExplicitVmRoute(path: string): ExplicitVmRoute | null {
  const match = path.match(/^\/vm\/([^/]+)(?:\/(.*))?$/);
  if (!match?.[1] || !HANDLE_PATTERN.test(match[1])) return null;
  const rest = match[2];
  return {
    handle: match[1],
    upstreamPath: rest ? `/${rest}` : '/',
  };
}

export function readExplicitVmWebSocketRoute(path: string): ExplicitVmRoute | null {
  try {
    const url = new URL(path, 'https://app.matrix-os.com');
    return readExplicitVmRoute(url.pathname);
  } catch (err: unknown) {
    if (err instanceof TypeError) return null;
    throw err;
  }
}

export function buildExplicitVmWebSocketUpstreamPath(path: string): string {
  try {
    const url = new URL(path, 'https://app.matrix-os.com');
    const route = readExplicitVmRoute(url.pathname);
    if (!route) return path;
    return `${route.upstreamPath}${url.search}`;
  } catch (err: unknown) {
    if (err instanceof TypeError) return path;
    throw err;
  }
}

export function isNativeAppStreamPath(path: string): boolean {
  return NATIVE_APP_STREAM_PATH.test(path);
}

export function hasExplicitVmNativeAppStreamCapability(
  method: string,
  route: ExplicitVmRoute,
): boolean {
  return (method === 'GET' || method === 'HEAD')
    && NATIVE_APP_STREAM_CAPABILITY_PATH.test(route.upstreamPath);
}

function readGatewayRouteCookie(path: string, cookieHeader: string | undefined): string | null {
  if (!isAppDomainGatewayPath(path)) return null;
  const handle = readCookie(cookieHeader, SHELL_ROUTE_COOKIE);
  return handle && HANDLE_PATTERN.test(handle) ? handle : null;
}

export function readAppDomainRouteCookie(path: string, cookieHeader: string | undefined): string | null {
  return readGatewayRouteCookie(path, cookieHeader) ?? readShellRouteCookie(path, cookieHeader);
}

function isSyncJwtAuthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const errorWithCode = err as Error & { code?: unknown };
  const errorCode = typeof errorWithCode.code === 'string'
    ? errorWithCode.code
    : '';
  return (
    err.name.startsWith('JWT') ||
    err.name.startsWith('JWS') ||
    err.name.startsWith('JOSE') ||
    errorCode.startsWith('ERR_JOSE_') ||
    err.message === 'Invalid sync JWT claims' ||
    err.message.startsWith('JWT handle ')
  );
}

export async function resolveSyncBearerIdentity(opts: {
  authorization: string | undefined;
  db: PlatformDB;
  platformJwtSecret: string;
  legacyContainerRoutingEnabled?: boolean;
}): Promise<SyncBearerIdentity | null> {
  const match = /^Bearer ([^\s]+)$/.exec(opts.authorization ?? '');
  const token = match?.[1];
  if (!token || token.length < 32 || token.length > 8192) return null;

  let claims: Awaited<ReturnType<typeof verifySyncJwt>>;
  try {
    claims = await verifySyncJwt(token, { secret: opts.platformJwtSecret });
  } catch (err: unknown) {
    if (isSyncJwtAuthError(err)) return null;
    throw err;
  }

  const runtimeSlot = RuntimeSlotSchema.safeParse(claims.runtime_slot).success
    ? claims.runtime_slot
    : undefined;
  const record = opts.legacyContainerRoutingEnabled === false
    ? undefined
    : await getContainer(opts.db, claims.handle);
  if (record?.clerkUserId === claims.sub) {
    return {
      handle: record.handle,
      userId: record.clerkUserId,
      runtimeSlot,
      expiresAt: claims.exp,
    };
  }

  const machine = await getActiveUserMachineByHandle(opts.db, claims.handle, runtimeSlot);
  if (!machine || machine.clerkUserId !== claims.sub) return null;
  return {
    handle: machine.handle,
    userId: machine.clerkUserId,
    runtimeSlot: machine.runtimeSlot,
    expiresAt: claims.exp,
  };
}

export async function resolveAppDomainIdentity(opts: {
  authHeader: string | undefined;
  cookieHeader: string | undefined;
  clerkAuth?: ClerkAuth;
  db: PlatformDB;
  platformJwtSecret: string;
  allowUnroutedClerkIdentity?: boolean;
  clerkPrincipalOnly?: boolean;
  legacyContainerRoutingEnabled?: boolean;
  requestedHandle?: string | null;
  runtimeSlot: string;
  wsToken?: string | null;
}): Promise<AppDomainIdentity | null> {
  const codeSessionToken = readCookie(opts.cookieHeader, CODE_SESSION_COOKIE);
  const appSessionToken = readCookie(opts.cookieHeader, APP_SESSION_COOKIE);
  const bearerToken =
    opts.authHeader?.startsWith('Bearer ')
      ? opts.authHeader.slice(7)
      : opts.wsToken ?? appSessionToken ?? codeSessionToken;

  if (bearerToken && opts.platformJwtSecret) {
    try {
      const claims = await verifySyncJwt(bearerToken, { secret: opts.platformJwtSecret });
      if (bearerToken === appSessionToken && opts.clerkAuth) {
        const clerkToken = opts.clerkAuth.extractToken(undefined, opts.cookieHeader);
        if (clerkToken) {
          const clerkResult = await opts.clerkAuth.verify(clerkToken);
          if (clerkResult.authenticated && clerkResult.userId && clerkResult.userId !== claims.sub) {
            return null;
          }
        }
      }
      const runtimeSlot = RuntimeSlotSchema.safeParse(claims.runtime_slot).success
        ? claims.runtime_slot
        : undefined;
      if (opts.clerkPrincipalOnly) {
        return {
          handle: claims.handle,
          userId: claims.sub,
          runtimeSlot,
          source: 'auth',
        };
      }
      const record = opts.legacyContainerRoutingEnabled === false
        ? undefined
        : await getContainer(opts.db, claims.handle);
      if (record?.clerkUserId === claims.sub) {
        return {
          handle: record.handle,
          userId: record.clerkUserId,
          source: 'auth',
        };
      }
      const machine = await getRunningUserMachineByHandle(opts.db, claims.handle, runtimeSlot);
      if (machine?.clerkUserId === claims.sub) {
        return {
          handle: machine.handle,
          userId: machine.clerkUserId,
          runtimeSlot: machine.runtimeSlot,
          source: 'auth',
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
        source: 'auth',
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

  if (opts.clerkPrincipalOnly) {
    return {
      handle: '',
      userId: result.userId,
    };
  }

  if (opts.requestedHandle) {
    let requestedMachine = await getActiveUserMachineByHandle(
      opts.db,
      opts.requestedHandle,
      opts.runtimeSlot,
    );
    if (!requestedMachine && opts.runtimeSlot === 'primary') {
      requestedMachine = await getActiveUserMachineByHandle(opts.db, opts.requestedHandle);
    }
    if (requestedMachine && requestedMachine.clerkUserId === result.userId) {
      return {
        handle: requestedMachine.handle,
        userId: result.userId,
        runtimeSlot: requestedMachine.runtimeSlot,
      };
    }
  }

  const record = opts.legacyContainerRoutingEnabled === false
    ? undefined
    : await getContainerByClerkId(opts.db, result.userId);
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

export function shouldMarkNativeAppSession(
  identity: AppDomainIdentity,
  authHeader: string | undefined,
  cookieHeader: string | undefined,
  platformJwtSecret: string,
): boolean {
  if (identity.source !== 'auth') return false;
  if (authHeader?.startsWith('Bearer ')) return true;
  return isValidNativeAppSessionProof(
    readCookie(cookieHeader, APP_SESSION_COOKIE),
    readCookie(cookieHeader, NATIVE_APP_SESSION_COOKIE),
    platformJwtSecret,
  );
}
