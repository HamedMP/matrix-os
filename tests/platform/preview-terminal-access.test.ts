import { describe, expect, it } from "vitest";
import { buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";
import {
  buildPreviewTerminalAccess,
  PREVIEW_TERMINAL_ACCESS_HEADER,
} from "../../packages/platform/src/preview-terminal-access.js";
import { buildPlatformWebSocketUpgradeHeaders } from "../../packages/platform/src/session-routing-websocket.js";
import { shouldForwardProxyHeader } from "../../packages/platform/src/session-routing-proxy.js";
import { verifyPreviewTerminalAccess } from "../../packages/gateway/src/preview-terminal-access.js";

const machine = {
  handle: "pr-1644",
  runtimeSlot: "pr-1644",
  provisioningClass: "preview" as const,
  clerkUserId: "user_owner",
  accessClerkUserIds: ["user_one", "user_two"],
};
const platformSecret = "platform-secret-preview-access";
const key = buildPlatformVerificationToken(machine.handle, platformSecret);

function verify(value: string | undefined, actorId = "user_one", runtimeSlot = machine.runtimeSlot) {
  return verifyPreviewTerminalAccess({
    value,
    key,
    actorId,
    configuredOwnerIds: [machine.clerkUserId, machine.clerkUserId],
    runtimeSlot,
  });
}

describe("platform preview terminal access boundary", () => {
  it.each(machine.accessClerkUserIds)("authorizes %s from current preview machine state", (actorId) => {
    for (const path of ["/api/terminal/workspaces", "/api/terminal/workspaces/ensure", "/ws/terminal/tab"]) {
      const value = buildPreviewTerminalAccess({ machine, actorId, path, platformSecret });
      expect(verify(value, actorId)).toBe(machine.clerkUserId);
      expect(value?.split(".")[0]).toBe(machine.clerkUserId);
    }
  });

  it("does not authorize owners, unlisted actors, customers, name-only previews, or other APIs", () => {
    expect(buildPreviewTerminalAccess({ machine, actorId: machine.clerkUserId,
      path: "/api/terminal/workspaces", platformSecret })).toBeUndefined();
    expect(buildPreviewTerminalAccess({ machine, actorId: "user_unlisted",
      path: "/api/terminal/workspaces", platformSecret })).toBeUndefined();
    expect(buildPreviewTerminalAccess({ machine, actorId: "user_one",
      path: "/api/terminal/workspaces", platformSecret: "" })).toBeUndefined();
    expect(buildPreviewTerminalAccess({ machine: { ...machine, provisioningClass: "customer" } as never,
      actorId: "user_one", path: "/api/terminal/workspaces", platformSecret })).toBeUndefined();
    expect(buildPreviewTerminalAccess({ machine: { ...machine, provisioningClass: "customer",
      handle: "pr-1644", runtimeSlot: "pr-1644" } as never,
      actorId: "user_one", path: "/api/terminal/workspaces", platformSecret })).toBeUndefined();
    for (const path of ["/api/projects", "/api/auth/ws-token", "/ws", "/ws/terminal/session", "/api/terminal-evil/workspaces"]) {
      expect(buildPreviewTerminalAccess({ machine, actorId: "user_one", path, platformSecret })).toBeUndefined();
    }
  });

  it("binds the decision to actor, owner, per-handle key, and receiving runtime slot", () => {
    const value = buildPreviewTerminalAccess({ machine, actorId: "user_one",
      path: "/api/terminal/workspaces", platformSecret })!;
    expect(verify(value, "user_two")).toBeUndefined();
    expect(verify(value, "user_one", "pr-9999")).toBeUndefined();
    expect(verifyPreviewTerminalAccess({ value, key: "wrong-key", actorId: "user_one",
      configuredOwnerIds: [machine.clerkUserId], runtimeSlot: machine.runtimeSlot })).toBeUndefined();
    expect(verifyPreviewTerminalAccess({ value, key, actorId: "user_one",
      configuredOwnerIds: ["user_other"], runtimeSlot: machine.runtimeSlot })).toBeUndefined();
    for (const invalid of [undefined, "", "malformed", "x".repeat(513), `${value.slice(0, -1)}z`]) {
      expect(verify(invalid)).toBeUndefined();
    }
  });

  it("strips client identity and access headers before trusted HTTP and WebSocket forwarding", () => {
    const names = [PREVIEW_TERMINAL_ACCESS_HEADER, "x-platform-verified", "x-platform-user-id"];
    for (const name of names) {
      expect(shouldForwardProxyHeader(name, "forged")).toBe(false);
      expect(shouldForwardProxyHeader(name.toUpperCase(), "forged")).toBe(false);
    }
    const previewTerminalAccess = buildPreviewTerminalAccess({ machine, actorId: "user_one",
      path: "/ws/terminal/tab", platformSecret });
    const headers = buildPlatformWebSocketUpgradeHeaders({
      incomingHeaders: Object.fromEntries(names.flatMap((name) => [[name, "forged"], [name.toUpperCase(), "forged"]])),
      externalHost: "app.matrix-os.com",
      handle: machine.handle,
      userId: "user_one",
      platformSecret,
      includePlatformProof: true,
      isCodeDomain: false,
      previewTerminalAccess,
    });
    expect(headers).not.toContain("forged");
    expect(headers).toContain("x-platform-user-id: user_one");
    expect(headers.match(new RegExp(`${PREVIEW_TERMINAL_ACCESS_HEADER}:`, "g"))).toHaveLength(1);
  });
});
