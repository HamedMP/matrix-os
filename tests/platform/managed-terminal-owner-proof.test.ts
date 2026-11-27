import { describe, expect, it } from "vitest";
import { canonicalPreviewDriveTurnBody } from "@matrix-os/contracts";
import { TERMINAL_CONTROL_COMMAND } from "@matrix-os/contracts/herdr-terminals";
import { managedTerminalBodyDigest } from "@matrix-os/contracts/managed-terminal-proof";
import {
  authenticatedManagedTerminalProxyProof,
  verifyManagedTerminalOwnerProof,
} from "../../packages/platform/src/managed-terminal-owner-proof.js";

const ownerId = "user_terminal_owner";
const machine = {
  machineId: "source_machine", runtimeSlot: "dev", clerkUserId: ownerId, runtimeTokenEpoch: 7,
  status: "running" as const, activationState: "authorized" as const, accessClerkUserIds: [],
  provisioningClass: "customer" as const, deletedAt: null,
};
const now = Date.now();
const platformSecret = "platform-owner-test-secret";
const identity = {
  userId: ownerId, handle: "bound-source", source: "auth" as const, sessionProvenance: "clerk-browser" as const,
  verifiedHumanBrowserExpiresAt: Math.floor(now / 1000) + 30,
  sessionExpiresAt: Math.floor(now / 1000) + 90,
};
const path = "/api/chats/chat_a/turns";
const workspaceId = "tws_6d6774" + "1".repeat(26);
const tabId = "tt_" + "a".repeat(32);
const revision = "b".repeat(64);
const selected = {
  type: "resource_reference",
  resource: { id: workspaceId + ":" + tabId, label: "Test terminal", kind: "terminal_session", revision },
};
const turn = {
  clientRequestId: "req_owner_test", baseRevision: 1, selection: { instanceId: "codex_default", model: "fixture" },
  interactionMode: "default", permissionMode: "full_access",
  executionRoot: { kind: "worktree", projectId: "proj_fixture", worktreeId: "wt_1111111111111111" },
  parts: [{ type: "text", text: "Run tests" }, { type: "invocation_reference", invocation: TERMINAL_CONTROL_COMMAND }, selected],
};

function request(body: unknown, route = path, options: RequestInit = {}) {
  return new Request("https://app.example.test" + route, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...options,
  });
}

async function mint(body: unknown = turn, extra: Partial<Parameters<typeof authenticatedManagedTerminalProxyProof>[0]> = {}) {
  return authenticatedManagedTerminalProxyProof({
    request: request(body), method: "POST", path, machine, identity, platformSecret, now, ...extra,
  });
}

describe("managed terminal owner proof from the authenticated Chat proxy", () => {
  it("authorizes the exact source, browser turn and selected target with bounded activation", async () => {
    const proof = await mint();
    expect(typeof proof).toBe("string");
    expect(verifyManagedTerminalOwnerProof(proof as string, { platformSecret, now })).toMatchObject({
      ownerId, sourceMachineId: machine.machineId, sourceRuntimeSlot: machine.runtimeSlot, sourceEpoch: 7,
      chatId: "chat_a", worktreeId: "wt_1111111111111111", clientRequestId: "req_owner_test", workspaceId, tabId, revision,
      bodyDigest: managedTerminalBodyDigest(canonicalPreviewDriveTurnBody(turn)),
      activateBefore: identity.verifiedHumanBrowserExpiresAt * 1000, expiresAt: now + 15 * 60_000,
    });
    const afterAuthentication = identity.verifiedHumanBrowserExpiresAt * 1000 + 1;
    expect(verifyManagedTerminalOwnerProof(proof as string, { platformSecret, now: afterAuthentication }))
      .toMatchObject({ activateBefore: expect.any(Number) });
    expect(verifyManagedTerminalOwnerProof(proof as string, { platformSecret, now: now + 15 * 60_000 })).toBeNull();
    expect(verifyManagedTerminalOwnerProof(proof as string, { platformSecret: "owned runtime proof", now })).toBeNull();
    expect(verifyManagedTerminalOwnerProof((proof as string).replace(/^./, "Z"), { platformSecret, now })).toBeNull();
  });

  it("binds the signed proof to the exact owner-submitted prompt", async () => {
    const first = await mint();
    const changed = { ...turn, parts: [{ type: "text", text: "Read logs" }, ...turn.parts.slice(1)] };
    const second = await mint(changed);
    const initial = verifyManagedTerminalOwnerProof(first as string, { platformSecret, now });
    const replacement = verifyManagedTerminalOwnerProof(second as string, { platformSecret, now });
    expect(initial?.clientRequestId).toBe(replacement?.clientRequestId);
    expect(replacement?.bodyDigest).toBe(managedTerminalBodyDigest(canonicalPreviewDriveTurnBody(changed)));
    expect(initial?.bodyDigest).not.toBe(replacement?.bodyDigest);
  });

  it("refuses machine-only, foreign, delegated and expired identities before reading the body", async () => {
    const body = request(turn);
    expect(await mint(turn, { identity: { ...identity, sessionProvenance: undefined }, request: body })).toBeNull();
    expect(body.bodyUsed).toBe(false);
    expect(await mint(turn, { identity: { ...identity, verifiedHumanBrowserExpiresAt: undefined } })).toBeNull();
    expect(await mint(turn, { identity: { ...identity, sessionProvenance: "clerk-device" } })).toBeNull();
    expect(await mint(turn, { identity: { ...identity, userId: "user_foreign" } })).toBeNull();
    expect(await mint(turn, { machine: { ...machine, accessClerkUserIds: ["user_delegate"] } })).toBeNull();
    expect(await mint(turn, { identity: { ...identity, sessionExpiresAt: Math.floor(now / 1000) - 1 } })).toBeNull();
  });

  it("rejects retry/queue routes, unscoped choices, and multiple targets", async () => {
    expect(await mint(turn, { path: "/api/chats/chat_a/runs/run_a/retry" })).toBeNull();
    expect(await mint(turn, { path: "/api/chats/chat_a/queued-turns" })).toBeNull();
    expect(await mint({ ...turn, permissionMode: "supervised" })).toBeNull();
    expect(await mint({ ...turn, executionRoot: undefined })).toBeNull();
    expect(await mint({ ...turn, parts: [...turn.parts, selected] })).toBeNull();
    expect(await mint({ ...turn, parts: turn.parts.slice(0, 2) })).toBeNull();
    expect(await mint({ ...turn, parts: [...turn.parts.slice(0, 2), { ...selected, resource: { ...selected.resource, id: "tws_" + "f".repeat(32) + ":" + tabId } }] })).toBeNull();
    expect(await mint(turn, { request: request(turn, path + "?token=machine") })).toBeNull();
  });

  it("bounds the authenticated proxy body and rejects invalid JSON", async () => {
    expect(await mint(turn, { request: request(turn, path, { body: "x".repeat(128 * 1024 + 1) }) })).toEqual({ status: 413 });
    expect(await mint(turn, { request: request(turn, path, { body: "{" }) })).toEqual({ status: 400 });
  });
});
