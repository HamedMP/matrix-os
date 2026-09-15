import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildPreviewTerminalDelegation } from "../../packages/platform/src/preview-terminal-delegation.js";
import { buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";
import { buildPlatformWebSocketUpgradeHeaders } from "../../packages/platform/src/session-routing-websocket.js";
import { shouldForwardProxyHeader } from "../../packages/platform/src/session-routing-proxy.js";
import { verifyPreviewTerminalDelegation } from "../../packages/gateway/src/preview-terminal-delegation.js";

const machine = {
  handle: "pr-1644", runtimeSlot: "pr-1644", provisioningClass: "preview" as const,
  clerkUserId: "user_owner", accessClerkUserIds: ["user_one", "user_two"],
};
const platformSecret = "platform-secret-delegation-test";
const key = buildPlatformVerificationToken(machine.handle, platformSecret);
const env = { MATRIX_HANDLE: machine.handle, MATRIX_RUNTIME_SLOT: machine.runtimeSlot,
  MATRIX_USER_ID: machine.clerkUserId, MATRIX_CLERK_USER_ID: machine.clerkUserId };
const options = { machine, actorId: "user_one", path: "/api/terminal/workspaces", platformSecret, now: 1000 };
const verify = (value: string | undefined, overrides = {}) => verifyPreviewTerminalDelegation({
  value, key, actorId: options.actorId, env, now: 1001, ...overrides,
});
function sign(payload: string) {
  const encoded = Buffer.from(payload).toString("base64url");
  return `${encoded}.${createHmac("sha256", key).update(`preview-terminal-v1:${encoded}`).digest("hex")}`;
}

describe("platform preview terminal delegation boundary", () => {
  it.each(machine.accessClerkUserIds)("signs terminal-only authority for %s from current machine state", (actorId) => {
    for (const path of ["/api/terminal/workspaces", "/api/terminal/workspaces/ensure", "/ws/terminal/tab"]) {
      const value = buildPreviewTerminalDelegation({ ...options, actorId, path });
      expect(verify(value, { actorId })).toMatchObject({ actorId, ownerId: machine.clerkUserId,
        role: "preview-collaborator", handle: machine.handle, runtimeSlot: machine.runtimeSlot });
    }
  });
  it("does not issue authority for owners, unlisted actors, customers, name-only previews, or other APIs", () => {
    expect(buildPreviewTerminalDelegation({ ...options, actorId: machine.clerkUserId })).toBeUndefined();
    expect(buildPreviewTerminalDelegation({ ...options, actorId: "user_unlisted" })).toBeUndefined();
    expect(buildPreviewTerminalDelegation({ ...options, platformSecret: "" })).toBeUndefined();
    for (const provisioningClass of ["customer", "preview"]) {
      expect(buildPreviewTerminalDelegation({ ...options,
        machine: { ...machine, provisioningClass, handle: "customer", runtimeSlot: "primary" } as typeof machine,
      })).toBeUndefined();
    }
    expect(buildPreviewTerminalDelegation({ ...options,
      machine: { ...machine, provisioningClass: "customer" } as never,
    })).toBeUndefined();
    for (const path of ["/api/projects", "/api/auth/ws-token", "/ws", "/ws/terminal/session", "/api/terminal-evil/workspaces"]) {
      expect(buildPreviewTerminalDelegation({ ...options, path })).toBeUndefined();
    }
  });
  it("accepts the legacy server-classified preview slot only on that exact slot", () => {
    const value = buildPreviewTerminalDelegation({ ...options, machine: { ...machine, runtimeSlot: "preview" } });
    expect(verify(value, { env: { ...env, MATRIX_RUNTIME_SLOT: "preview" } })).toBeDefined();
    expect(verify(value)).toBeUndefined();
  });
  it("fails closed for malformed signed payloads, forged bytes, invalid config and expiry", () => {
    const value = buildPreviewTerminalDelegation(options)!;
    for (const invalid of ["", "malformed", "x".repeat(4097), sign("{"), sign("null"), sign("{}"), `${value.slice(0, -1)}z`]) {
      expect(verify(invalid)).toBeUndefined();
    }
    expect(verify(value, { key: "incorrect-key" })).toBeUndefined();
    expect(verify(value, { key: "" })).toBeUndefined();
    expect(verify(value, { now: 1030 })).toBeUndefined();
    expect(verify(value, { now: 994 })).toBeUndefined();
    for (const invalidEnv of [
      { ...env, MATRIX_HANDLE: "pr-9999" }, { ...env, MATRIX_RUNTIME_SLOT: "primary" },
      { ...env, MATRIX_HANDLE: "customer" }, { ...env, MATRIX_USER_ID: "" , MATRIX_CLERK_USER_ID: "" },
      { ...env, MATRIX_CLERK_USER_ID: "user_other" }, { ...env, MATRIX_RUNTIME_SLOT: "" },
    ]) expect(verify(value, { env: invalidEnv })).toBeUndefined();
    const claims = JSON.parse(Buffer.from(value.split(".")[0], "base64url").toString());
    for (const changes of [
      { provisioningClass: "customer" }, { role: "owner" }, { scope: "all" }, { version: 2 },
      { actorId: "user_other" }, { ownerId: "user_other" }, { actorId: machine.clerkUserId },
      { issuedAt: 1002, expiresAt: 1002 }, { expiresAt: 1031 }, { extra: "unexpected" },
    ]) expect(verify(sign(JSON.stringify({ ...claims, ...changes })))).toBeUndefined();
  });
  it("strips client authorization context in HTTP and WebSocket forwarding", () => {
    const names = ["x-platform-preview-terminal", "x-platform-verified", "x-platform-user-id"];
    for (const name of names) {
      expect(shouldForwardProxyHeader(name, "forged")).toBe(false);
      expect(shouldForwardProxyHeader(name.toUpperCase(), "forged")).toBe(false);
    }
    const headers = buildPlatformWebSocketUpgradeHeaders({
      incomingHeaders: Object.fromEntries(names.flatMap((name) => [[name, "forged"], [name.toUpperCase(), "forged"]])),
      externalHost: "app.matrix-os.com", handle: machine.handle, userId: options.actorId,
      platformSecret, includePlatformProof: true, isCodeDomain: false,
      previewTerminalDelegation: buildPreviewTerminalDelegation(options),
    });
    expect(headers).not.toContain("forged");
    expect(headers).toContain(`x-platform-user-id: ${options.actorId}`);
    expect(headers.match(/x-platform-preview-terminal:/g)).toHaveLength(1);
  });
});
