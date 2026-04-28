import type { SyncJwtClaims } from "./auth-jwt.js";

export const JWT_CLAIMS_CONTEXT_KEY = "jwtClaims";
export const AUTH_CONTEXT_READY_CONTEXT_KEY = "authContextReady";
export const SAFE_PRINCIPAL_USER_ID = /^[A-Za-z0-9_-]{1,256}$/;

export type PrincipalSource = "jwt" | "configured-container" | "dev-default";

export interface RequestPrincipal {
  userId: string;
  source: PrincipalSource;
}

export interface PrincipalRuntimeConfig {
  configuredUserId?: string;
  isTrustedSingleUserGateway: boolean;
  authEnabled: boolean;
  isProduction: boolean;
  isLocalDevelopment: boolean;
  devDefaultUserId: string;
  requireAuthContextReady?: boolean;
}

type PrincipalContextReader = { get: (key: never) => unknown };
type PrincipalContextWriter = { set: (key: never, value: unknown) => unknown };

export class MissingRequestPrincipalError extends Error {
  constructor() {
    super("Missing request principal");
    this.name = "MissingRequestPrincipalError";
  }
}

export class InvalidRequestPrincipalError extends Error {
  constructor(readonly source: PrincipalSource) {
    super("Invalid request principal");
    this.name = "InvalidRequestPrincipalError";
  }
}

export class RequestPrincipalMisconfiguredError extends Error {
  constructor() {
    super("Request principal context is not initialized");
    this.name = "RequestPrincipalMisconfiguredError";
  }
}

export type RequestPrincipalError =
  | MissingRequestPrincipalError
  | InvalidRequestPrincipalError
  | RequestPrincipalMisconfiguredError;

export function markAuthContextReady(c: PrincipalContextWriter): void {
  if (typeof c.set === "function") {
    c.set(AUTH_CONTEXT_READY_CONTEXT_KEY as never, true);
  }
}

export function isAuthContextReady(c: PrincipalContextReader): boolean {
  return typeof c.get === "function" && c.get(AUTH_CONTEXT_READY_CONTEXT_KEY as never) === true;
}

function readClaims(c: PrincipalContextReader): SyncJwtClaims | undefined {
  if (typeof c.get !== "function") return undefined;
  return c.get(JWT_CLAIMS_CONTEXT_KEY as never) as SyncJwtClaims | undefined;
}

function isLocalDevelopmentEnv(env: NodeJS.ProcessEnv): boolean {
  const nodeEnv = env.NODE_ENV;
  return nodeEnv === undefined || nodeEnv === "" || nodeEnv === "development" || nodeEnv === "test" || nodeEnv === "local";
}

export function readPrincipalRuntimeConfig(env: NodeJS.ProcessEnv = process.env): PrincipalRuntimeConfig {
  const configuredUserId = env.MATRIX_USER_ID;
  return {
    authEnabled: Boolean(env.MATRIX_AUTH_TOKEN),
    configuredUserId,
    devDefaultUserId: "default",
    isLocalDevelopment: isLocalDevelopmentEnv(env),
    isProduction: env.NODE_ENV === "production",
    isTrustedSingleUserGateway: Boolean(configuredUserId),
  };
}

function assertSafePrincipalUserId(userId: string, source: PrincipalSource): void {
  if (!SAFE_PRINCIPAL_USER_ID.test(userId)) {
    throw new InvalidRequestPrincipalError(source);
  }
}

export function getOptionalRequestPrincipal(
  c: PrincipalContextReader,
  config: Partial<PrincipalRuntimeConfig> = {},
): RequestPrincipal | null {
  const runtime = { ...readPrincipalRuntimeConfig(), ...config };
  if (runtime.requireAuthContextReady !== false && !isAuthContextReady(c)) {
    throw new RequestPrincipalMisconfiguredError();
  }

  const claims = readClaims(c);
  if (claims) {
    if (typeof claims.sub !== "string" || claims.sub.length === 0) {
      throw new InvalidRequestPrincipalError("jwt");
    }
    assertSafePrincipalUserId(claims.sub, "jwt");
    return { userId: claims.sub, source: "jwt" };
  }

  if (runtime.configuredUserId && runtime.isTrustedSingleUserGateway) {
    assertSafePrincipalUserId(runtime.configuredUserId, "configured-container");
    return { userId: runtime.configuredUserId, source: "configured-container" };
  }

  const canUseDevDefault =
    runtime.isLocalDevelopment &&
    !runtime.authEnabled &&
    !runtime.isProduction &&
    !runtime.configuredUserId;

  if (canUseDevDefault) {
    assertSafePrincipalUserId(runtime.devDefaultUserId, "dev-default");
    return { userId: runtime.devDefaultUserId, source: "dev-default" };
  }

  return null;
}

export function requireRequestPrincipal(
  c: PrincipalContextReader,
  config: Partial<PrincipalRuntimeConfig> = {},
): RequestPrincipal {
  const principal = getOptionalRequestPrincipal(c, config);
  if (!principal) throw new MissingRequestPrincipalError();
  return principal;
}

export function ownerScopeFromPrincipal(principal: RequestPrincipal): { type: "user"; id: string } {
  return { type: "user", id: principal.userId };
}

export function isRequestPrincipalError(err: unknown): err is RequestPrincipalError {
  return (
    err instanceof MissingRequestPrincipalError ||
    err instanceof InvalidRequestPrincipalError ||
    err instanceof RequestPrincipalMisconfiguredError
  );
}

export function mapRequestPrincipalError(err: RequestPrincipalError, serverErrorMessage = "Request failed"): {
  body: { error: string };
  log: boolean;
  status: 401 | 500;
} {
  if (err instanceof RequestPrincipalMisconfiguredError) {
    return { body: { error: serverErrorMessage }, log: true, status: 500 };
  }
  return { body: { error: "Unauthorized" }, log: false, status: 401 };
}
