import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("local object store image provenance", () => {
  it.each(["docker-compose.dev.yml", "docker-compose.dev-vps.yml"])("pins public Silo images and initializes a bucket with separate credentials in %s", (file) => {
    const { services } = parse(readFileSync(resolve(file), "utf8"));
    expect(services.minio.image).toBe("docker.io/pgsty/silo@sha256:635197cb9f36d01bee221d34d1c7d7960f6a95c48b0b6c01d99cd13bdae51a46");
    expect(services["minio-alias"].image).toBe("docker.io/pgsty/mc@sha256:cfc83108c3abb371f8fb84d99c1fdc88f8c237e022409b0081fb7c0a3be634dd");
    expect(services["minio-init"].image).toBe("docker.io/pgsty/mc@sha256:cfc83108c3abb371f8fb84d99c1fdc88f8c237e022409b0081fb7c0a3be634dd");
    expect(services["minio-alias"].command.slice(0, 4)).toEqual(["alias", "set", "local", "http://minio:9000"]);
    expect(services["minio-init"].command.slice(0, 2)).toEqual(["mb", expect.stringMatching(/^local\//)]);
    expect(services["minio-init"].depends_on["minio-alias"].condition).toBe("service_completed_successfully");
    expect(services.dev.depends_on["minio-init"].condition).toBe("service_completed_successfully");
    expect(services["minio-alias"].volumes).toEqual(services["minio-init"].volumes);
  });
});
