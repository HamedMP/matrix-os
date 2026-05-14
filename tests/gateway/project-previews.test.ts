import { describe, expect, it } from "vitest";
import {
  createPreviewRef,
  validatePreviewUrl,
} from "../../packages/gateway/src/workflow/preview-policy.js";

describe("project preview/browser URL policy", () => {
  it("allows approved localhost ports as sanitized preview refs", () => {
    expect(createPreviewRef({
      url: "http://localhost:3000",
      allowedPorts: [3000],
      label: "Dev",
    })).toEqual({
      label: "Dev",
      url: "http://localhost:3000/",
      port: 3000,
      status: "approved",
    });
  });

  it("rejects private, metadata, disallowed port, and redirecting browser URLs", () => {
    for (const url of [
      "http://127.0.0.1:3000",
      "http://169.254.169.254/latest/meta-data",
      "http://10.0.0.5:3000",
      "http://[fc00::1]:3000",
      "http://[::ffff:127.0.0.1]:3000",
      "http://localhost:9999",
      "https://example.com/redirect?to=http://localhost:3000",
    ]) {
      expect(validatePreviewUrl({ url, allowedPorts: [3000] })).toMatchObject({ ok: false });
    }
  });
});
