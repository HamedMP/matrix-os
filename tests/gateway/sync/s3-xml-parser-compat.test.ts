import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";

describe("S3 XML parser compatibility", () => {
  it("parses successful list responses so the home mirror can start", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/xml" });
      response.end(`<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>matrixos-sync</Name>
  <Prefix>users/test/home/</Prefix>
  <KeyCount>1</KeyCount>
  <MaxKeys>1000</MaxKeys>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>users/test/home/system/soul.md</Key>
    <LastModified>2026-10-30T00:00:00.000Z</LastModified>
    <ETag>&quot;fixture-etag&quot;</ETag>
    <Size>4</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
</ListBucketResult>`);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const { port } = server.address() as AddressInfo;
    const client = new S3Client({
      endpoint: `http://127.0.0.1:${port}`,
      region: "auto",
      forcePathStyle: true,
      maxAttempts: 1,
      credentials: {
        accessKeyId: "test-access-key",
        secretAccessKey: "test-secret-key",
      },
    });

    try {
      const result = await client.send(new ListObjectsV2Command({
        Bucket: "matrixos-sync",
        Prefix: "users/test/home/",
      }));

      expect(result.Contents).toEqual([
        expect.objectContaining({
          Key: "users/test/home/system/soul.md",
          ETag: '"fixture-etag"',
          Size: 4,
        }),
      ]);
    } finally {
      client.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
