import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { buildSpeechPreviewActivation, selectSharePreviewMachine } from "../../scripts/chat-share-preview-fixture.mjs";
it("selects only the exact running PR preview identity", () => {
  const preview = { handle: "pr-1551", runtimeSlot: "pr-1551", provisioningClass: "preview", status: "running", publicIPv4: "8.8.8.8", clerkUserId: "owner_1551", machineId: "machine_1551" };
  expect(selectSharePreviewMachine({ machines: [preview] }, "1551")).toEqual({ handle: "pr-1551", address: "8.8.8.8", ownerId: "owner_1551", machineId: "machine_1551", runtimeSlot: "pr-1551" });
  expect(() => selectSharePreviewMachine({ machines: [{ ...preview, provisioningClass: undefined }] }, "1551")).toThrow();
  for (const change of [{runtimeSlot:"primary"}, {provisioningClass:"customer"}, {status:"deleted"}, {publicIPv4:"127.0.0.1"}, {deletedAt:"today"}]) {
    expect(() => selectSharePreviewMachine({ machines: [{...preview,...change}] }, "1551")).toThrow();
  }
  expect(() => selectSharePreviewMachine({ machines: [preview, preview] }, "1551")).toThrow();
  expect(() => selectSharePreviewMachine({ machines: [preview] }, "main")).toThrow();
  expect(() => selectSharePreviewMachine({ machines: [{ ...preview, machineId: undefined }] }, "1551")).toThrow();
});

it("derives a speech-only token for the tagged preview origin", () => {
  const fixture = { handle: "pr-1551", runtimeSlot: "pr-1551", address: "8.8.8.8", ownerId: "owner_1551", machineId: "machine_1551" };
  const activation = buildSpeechPreviewActivation(fixture, "1551", "https://pr-1551---matrix-platform-preview-abc.ew.a.run.app", "s".repeat(32));
  expect(activation.speechRuntimeToken).toMatch(/^[a-f0-9]{64}$/);
  expect(activation.speechOrigin).toBe("https://pr-1551---matrix-platform-preview-abc.ew.a.run.app");
  expect(() => buildSpeechPreviewActivation(fixture, "1551", "https://platform.matrix-os.com", "s".repeat(32))).toThrow();
  expect(() => buildSpeechPreviewActivation(fixture, "1551", "not a url", "s".repeat(32)))
    .toThrow("Invalid preview speech origin");
});

it("retires only the prior synthetic route before seeding exact identity", () => {
  const source = readFileSync(new URL("../../scripts/chat-share-preview-fixture.mjs", import.meta.url), "utf8");
  expect(source).toContain("machine_id = $1 AND clerk_user_id = 'chat-share-preview-fixture'");
  expect(source).toContain("[`chat-share-preview-${handle}`, handle]");
  expect(source).toContain('const entryId = `speech-preview:${handle}:${machineGrantKey}`');
});
