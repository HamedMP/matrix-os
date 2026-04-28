import { describe, expect, it } from "vitest";
import {
  AUTH_CONTEXT_READY_CONTEXT_KEY,
  InvalidRequestPrincipalError,
  JWT_CLAIMS_CONTEXT_KEY,
  MissingRequestPrincipalError,
  RequestPrincipalMisconfiguredError,
  getOptionalRequestPrincipal,
  markAuthContextReady,
  ownerScopeFromPrincipal,
  readPrincipalRuntimeConfig,
  requireRequestPrincipal,
  type PrincipalRuntimeConfig,
} from "../../packages/gateway/src/request-principal.js";

function createContext(claims?: { sub: string; handle?: string }) {
  const store = new Map<string, unknown>();
  const ctx = {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => store.set(key, value),
  } as any;
  if (claims) ctx.set(JWT_CLAIMS_CONTEXT_KEY, { handle: "alice", gateway_url: "https://app", ...claims });
  return ctx;
}

const baseConfig: PrincipalRuntimeConfig = {
  authEnabled: true,
  configuredUserId: undefined,
  devDefaultUserId: "default",
  isLocalDevelopment: false,
  isProduction: false,
  isTrustedSingleUserGateway: false,
};

describe("request principal", () => {
  it("exports owner scope derived from a request principal", () => {
    expect(ownerScopeFromPrincipal({ userId: "user_123", source: "jwt" })).toEqual({
      type: "user",
      id: "user_123",
    });
  });

  it("requires auth middleware readiness before resolving a protected route principal", () => {
    const ctx = createContext({ sub: "user_123" });
    expect(() => requireRequestPrincipal(ctx, baseConfig)).toThrow(RequestPrincipalMisconfiguredError);
  });

  it("returns JWT principal before configured container identity", () => {
    const ctx = createContext({ sub: "user_123" });
    markAuthContextReady(ctx);

    expect(requireRequestPrincipal(ctx, {
      ...baseConfig,
      configuredUserId: "container_user",
      isTrustedSingleUserGateway: true,
    })).toEqual({ userId: "user_123", source: "jwt" });
  });

  it("accepts configured identity only for trusted single-user/container gateways", () => {
    const ctx = createContext();
    markAuthContextReady(ctx);

    expect(requireRequestPrincipal(ctx, {
      ...baseConfig,
      configuredUserId: "container_user",
      isTrustedSingleUserGateway: true,
    })).toEqual({ userId: "container_user", source: "configured-container" });

    expect(() => requireRequestPrincipal(ctx, {
      ...baseConfig,
      configuredUserId: "container_user",
      isTrustedSingleUserGateway: false,
    })).toThrow(MissingRequestPrincipalError);
  });

  it("derives configured container identity only from MATRIX_USER_ID", () => {
    expect(readPrincipalRuntimeConfig({
      MATRIX_HANDLE: "alice",
      NODE_ENV: "production",
    }).configuredUserId).toBeUndefined();

    expect(readPrincipalRuntimeConfig({
      MATRIX_HANDLE: "alice",
      MATRIX_USER_ID: "user_123",
      NODE_ENV: "production",
    })).toMatchObject({
      configuredUserId: "user_123",
      isTrustedSingleUserGateway: true,
    });
  });

  it("accepts dev-default only under the four-condition local development gate", () => {
    const ctx = createContext();
    markAuthContextReady(ctx);

    expect(requireRequestPrincipal(ctx, {
      ...baseConfig,
      authEnabled: false,
      isLocalDevelopment: true,
      isProduction: false,
    })).toEqual({ userId: "default", source: "dev-default" });

    expect(getOptionalRequestPrincipal(ctx, {
      ...baseConfig,
      authEnabled: true,
      isLocalDevelopment: true,
      isProduction: false,
    })).toBeNull();
    expect(getOptionalRequestPrincipal(ctx, {
      ...baseConfig,
      authEnabled: false,
      isLocalDevelopment: true,
      isProduction: true,
    })).toBeNull();
    expect(getOptionalRequestPrincipal(ctx, {
      ...baseConfig,
      authEnabled: false,
      configuredUserId: "container_user",
      isLocalDevelopment: true,
      isProduction: false,
      isTrustedSingleUserGateway: true,
    })).toEqual({ userId: "container_user", source: "configured-container" });
  });

  it("rejects malformed user ids before returning a principal", () => {
    const ctx = createContext({ sub: "../secret" });
    markAuthContextReady(ctx);

    expect(() => requireRequestPrincipal(ctx, baseConfig)).toThrow(InvalidRequestPrincipalError);
    try {
      requireRequestPrincipal(ctx, baseConfig);
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidRequestPrincipalError);
      expect((err as Error).message).not.toContain("../secret");
    }
  });

  it("marks auth context readiness on Hono context", () => {
    const ctx = createContext();
    expect(ctx.get(AUTH_CONTEXT_READY_CONTEXT_KEY)).toBeUndefined();
    markAuthContextReady(ctx);
    expect(ctx.get(AUTH_CONTEXT_READY_CONTEXT_KEY)).toBe(true);
  });
});
