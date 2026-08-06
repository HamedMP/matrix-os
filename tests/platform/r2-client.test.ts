import { describe, expect, it } from "vitest";

import { createR2Client } from "../../packages/platform/src/r2-client.js";

describe("platform R2 client", () => {
  it("trims object-store secrets and endpoints before creating the S3 client", async () => {
    const client = await createR2Client({
      accountId: " account-id\n",
      accessKeyId: "bundle-key\n",
      secretAccessKey: " bundle-secret ",
      bucket: " matrixos-bundles\n",
    });

    const url = new URL(await client.getPresignedGetUrl("system-bundles/dev.tar.gz"));
    expect(url.hostname).toBe("matrixos-bundles.account-id.r2.cloudflarestorage.com");
    expect(url.pathname).toContain("system-bundles/dev.tar.gz");
    expect(url.searchParams.get("X-Amz-Credential")).toContain("bundle-key");
    client.destroy();
  });

  it("rejects blank credentials after trimming", async () => {
    await expect(
      createR2Client({
        endpoint: "https://r2.example.com",
        accessKeyId: "\n",
        secretAccessKey: "secret",
        bucket: "matrixos-bundles",
      }),
    ).rejects.toThrow(/access key, secret key, and bucket/i);
  });

  it("signs public URLs with a separate public-endpoint client", async () => {
    const client = await createR2Client({
      endpoint: "http://127.0.0.1:9121",
      publicEndpoint: " https://bundles.example.com\n",
      accessKeyId: "bundle-key",
      secretAccessKey: "bundle-secret",
      bucket: "matrixos-bundles",
      forcePathStyle: true,
    });

    const url = new URL(await client.getPresignedGetUrl("system-bundles/dev.tar.gz"));
    expect(url.origin).toBe("https://bundles.example.com");
    expect(url.port).toBe("");
    expect(url.pathname).toBe("/matrixos-bundles/system-bundles/dev.tar.gz");
    expect(url.searchParams.has("X-Amz-Signature")).toBe(true);
    client.destroy();
  });
});
