import { describe, expect, it, vi } from "vitest";
import { admitsHostedBotsPrivatePreview, admitsOpenMausBotPreviewBundle } from "../../packages/gateway/src/hosted-bots/preview-admission.js";

const handle = "pv-1907-3fa91c2e";
const platform = "https://app.matrix-os.com";
const privatePreview: NodeJS.ProcessEnv = {
  MATRIX_PREVIEW_RUNTIME: "true",
  MATRIX_COLLABORATION_DISABLED: "1",
  MATRIX_HANDLE: handle,
  MATRIX_RUNTIME_SLOT: handle,
  PLATFORM_INTERNAL_URL: platform,
  MATRIX_UPDATE_MANIFEST_BASE_URL: `${platform}/private-preview-updates/${handle}`,
};

describe("Hosted Bots Private Preview admission", () => {
  it("checks the fixed bundle marker only after owner-only preview admission", () => {
    const markerExists = vi.fn().mockReturnValue(false);
    expect(admitsOpenMausBotPreviewBundle({ ...privatePreview, MATRIX_RUNTIME_SLOT: "primary" }, markerExists)).toBe(false);
    expect(markerExists).not.toHaveBeenCalled();
    expect(admitsOpenMausBotPreviewBundle(privatePreview, markerExists)).toBe(false);
    expect(markerExists).toHaveBeenCalledExactlyOnceWith("/opt/matrix/app/MATRIX_OPENMAUSBOT_PREVIEW");
    markerExists.mockReturnValue(true);
    expect(admitsOpenMausBotPreviewBundle(privatePreview, markerExists)).toBe(true);
  });

  it("admits the exact owner-only preview projection emitted by Platform", () => {
    expect(admitsHostedBotsPrivatePreview(privatePreview)).toBe(true);
  });

  it.each(Object.keys(privatePreview))("fails closed when %s is missing", (key) => {
    expect(admitsHostedBotsPrivatePreview({ ...privatePreview, [key]: undefined })).toBe(false);
  });

  it.each([
    ["regular customer", { MATRIX_PREVIEW_RUNTIME: "false", MATRIX_RUNTIME_SLOT: "primary" }],
    ["shared PR preview", { MATRIX_HANDLE: "pr-1907", MATRIX_RUNTIME_SLOT: "pr-1907" }],
    ["paired preview", { MATRIX_HANDLE: "cp-1907-3fa91c2e-1-a", MATRIX_RUNTIME_SLOT: "cp-1907-3fa91c2e-1-a" }],
    ["collaboration enabled", { MATRIX_COLLABORATION_DISABLED: "0" }],
    ["another runtime slot", { MATRIX_RUNTIME_SLOT: "pv-1907-3fa91c3e" }],
    ["another update handle", { MATRIX_UPDATE_MANIFEST_BASE_URL: `${platform}/private-preview-updates/pv-1907-3fa91c3e` }],
    ["another update origin", { MATRIX_UPDATE_MANIFEST_BASE_URL: `https://other.example/private-preview-updates/${handle}` }],
    ["update query", { MATRIX_UPDATE_MANIFEST_BASE_URL: `${platform}/private-preview-updates/${handle}?other=1` }],
    ["invalid platform URL", { PLATFORM_INTERNAL_URL: "invalid" }],
    ["platform path", { PLATFORM_INTERNAL_URL: `${platform}/different` }],
    ["platform credentials", { PLATFORM_INTERNAL_URL: "https://user@app.matrix-os.com" }],
  ] satisfies [string, NodeJS.ProcessEnv][])("denies %s", (_case, overrides) => {
    expect(admitsHostedBotsPrivatePreview({ ...privatePreview, ...overrides })).toBe(false);
  });
});
