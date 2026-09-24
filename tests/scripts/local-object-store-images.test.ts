import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("local object store image provenance", () => {
  it.each(["docker-compose.dev.yml", "docker-compose.dev-vps.yml"])("pins public Silo images and initializes a bucket without a shell in %s", (file) => {
    const { services } = parse(readFileSync(resolve(file), "utf8"));
    expect(services.minio.image).toBe("docker.io/pgsty/silo@sha256:635197cb9f36d01bee221d34d1c7d7960f6a95c48b0b6c01d99cd13bdae51a46");
    expect(services["minio-init"].image).toBe("docker.io/pgsty/mc@sha256:cfc83108c3abb371f8fb84d99c1fdc88f8c237e022409b0081fb7c0a3be634dd");
    expect(services["minio-init"].entrypoint).toBeUndefined();
    expect(services["minio-init"].environment.MC_HOST_local).toContain("@minio:9000");
    expect(services["minio-init"].command).toContain("mb local/");
  });
});
