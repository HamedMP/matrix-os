import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("local object store image provenance", () => {
  it.each(["docker-compose.dev.yml", "docker-compose.dev-vps.yml"])("pins official Quay images in %s", (file) => {
    const { services } = parse(readFileSync(resolve(file), "utf8"));
    expect(services.minio.image).toMatch(/^quay\.io\/minio\/minio@sha256:[a-f0-9]{64}$/);
    expect(services["minio-init"].image).toMatch(/^quay\.io\/minio\/mc@sha256:[a-f0-9]{64}$/);
  });
});
