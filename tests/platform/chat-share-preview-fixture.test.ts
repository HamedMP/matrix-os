import { expect, it } from "vitest";
import { selectSharePreviewMachine } from "../../scripts/chat-share-preview-fixture.mjs";
it("selects only the exact running PR preview and strips owner metadata", () => {
  const preview = { handle: "pr-1551", runtimeSlot: "pr-1551", provisioningClass: "preview", status: "running", publicIPv4: "8.8.8.8", clerkUserId: "private" };
  expect(selectSharePreviewMachine({ machines: [preview] }, "1551")).toEqual({ handle: "pr-1551", address: "8.8.8.8" });
  expect(selectSharePreviewMachine({ machines: [{ ...preview, provisioningClass: undefined }] }, "1551").handle).toBe("pr-1551");
  for (const change of [{runtimeSlot:"primary"}, {provisioningClass:"customer"}, {status:"deleted"}, {publicIPv4:"127.0.0.1"}, {deletedAt:"today"}]) {
    expect(() => selectSharePreviewMachine({ machines: [{...preview,...change}] }, "1551")).toThrow();
  }
  expect(() => selectSharePreviewMachine({ machines: [preview, preview] }, "1551")).toThrow();
  expect(() => selectSharePreviewMachine({ machines: [preview] }, "main")).toThrow();
});
