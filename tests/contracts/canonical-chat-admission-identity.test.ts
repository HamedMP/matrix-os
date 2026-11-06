import { webcrypto } from "node:crypto";
import { expect, it } from "vitest";
import { canonicalChatTurnRequestIdentity } from "@matrix-os/contracts";
import { chatContextRequestHash } from "../../packages/gateway/src/chat/agent-context";

const request = {
  parts: [{ type: "text" as const, text: "Hello" }],
  selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol", options: [{ id: "reasoning", value: "high" }] },
  interactionMode: "plan", permissionMode: "supervised",
  executionRoot: { kind: "project" as const, projectId: "project_fixture" },
};

it("keeps the existing admission hash vector identical in Node and browser Web Crypto", async () => {
  const preimage = canonicalChatTurnRequestIdentity(request);
  expect(preimage).toBe('{"parts":[{"type":"text","text":"Hello"}],"selection":{"instanceId":"codex_fixture","model":"gpt-5.6-sol","options":[{"id":"reasoning","value":"high"}]},"interactionMode":"plan","permissionMode":"supervised","executionRoot":{"kind":"project","projectId":"project_fixture"}}');
  const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(preimage));
  const browserHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  expect(browserHash).toBe("ec95b528722cf66ad368c8fa1059b93cc30cae73ede8248d4c8d2ea5912bff22");
  expect(chatContextRequestHash(request)).toBe(browserHash);
});

it.each([
  { parts: [{ type: "text" as const, text: "Different" }] },
  { selection: { ...request.selection, model: "different-model" } },
  { selection: { ...request.selection, options: [{ id: "reasoning", value: "low" }] } },
  { interactionMode: "default" }, { permissionMode: "full_access" },
  { executionRoot: { kind: "project" as const, projectId: "project_other" } },
])("binds original payload field %j", (changed) => {
  expect(chatContextRequestHash({ ...request, ...changed })).not.toBe(chatContextRequestHash(request));
});

it("excludes concurrency fences from the persisted semantic identity", () => {
  expect(canonicalChatTurnRequestIdentity({ ...request, clientRequestId: "req_changed", baseRevision: 9 } as typeof request))
    .toBe(canonicalChatTurnRequestIdentity(request));
  const { executionRoot: _root, ...rootless } = request;
  expect(canonicalChatTurnRequestIdentity(rootless)).toContain('"executionRoot":null');
});
