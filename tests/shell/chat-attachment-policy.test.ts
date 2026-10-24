import { expect, it } from "vitest";
import { shellChatAttachmentPolicy } from "../../shell/src/components/chat/attachment-policy.js";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat.js";
it("uses the selected Bot coordinator's attachment and vision policy", () => {
  const catalog = createCanonicalProviderCatalogFixture(); const instance = catalog.instances[0]!;
  instance.driverKind = "matrix_pi"; instance.supports.attachments = ["file", "image"]; instance.models[0]!.supportsVision = true;
  const policy = shellChatAttachmentPolicy(catalog, { instanceId: instance.id, model: instance.models[0]!.id });
  expect(policy.enabled).toBe(true);
  expect(policy.error([{ type: "image/png", size: 100 }])).toBeNull();
  expect(policy.error([{ type: "image/gif", size: 100 }])).toContain("PNG, JPEG or WebP");
  instance.models[0]!.supportsVision = false;
  expect(shellChatAttachmentPolicy(catalog, { instanceId: instance.id, model: instance.models[0]!.id }).error([{ type: "image/png", size: 100 }])).toContain("does not support images");
});
it("keeps Automatic recipe input bounded while route suitability is checked on the server", () => {
  const policy = shellChatAttachmentPolicy(null, { instanceId: "matrix_bot_default", model: "auto" }, true);
  expect(policy.enabled).toBe(true);
  expect(policy.error([{ type: "text/plain", size: 10 * 1024 * 1024 }])).toBeNull();
  expect(policy.error([{ type: "text/plain", size: 10 * 1024 * 1024 + 1 }])).toContain("10 MiB");
  expect(shellChatAttachmentPolicy(null, undefined).enabled).toBe(false);
});
