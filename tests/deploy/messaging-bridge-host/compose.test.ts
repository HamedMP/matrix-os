import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { BUNDLE_DIR, NETWORKS } from "./helpers.js";

interface ComposeService {
  image: string;
  restart?: string;
  mem_limit?: string;
  ports?: string[];
  expose?: string[];
  networks?: string[];
  user?: string;
  read_only?: boolean;
  command?: string[];
  cap_drop?: string[];
  security_opt?: string[];
  volumes?: string[];
  environment?: Record<string, string>;
  healthcheck?: { test: string[] };
}

interface ComposeFile {
  services: Record<string, ComposeService>;
  networks: Record<string, { internal?: boolean } | null>;
}

const compose = parse(readFileSync(join(BUNDLE_DIR, "docker-compose.yml"), "utf8"), { merge: true }) as ComposeFile;
const services = Object.entries(compose.services);
const bridgeServices = NETWORKS.map((network) => `mautrix-${network}`);

describe("messaging bridge host compose bundle", () => {
  it("defines exactly the homeserver, its database, three bridges and the proxy", () => {
    expect(Object.keys(compose.services).sort()).toEqual(
      ["caddy", "mautrix-linkedin", "mautrix-telegram", "mautrix-whatsapp", "postgres", "synapse"].sort(),
    );
  });

  it("pins every image to an exact version tag", () => {
    for (const [name, service] of services) {
      const tag = service.image.split(":").at(-1) ?? "";
      expect(service.image, name).toMatch(/:[^/]+$/);
      expect(tag, name).not.toMatch(/^(latest|stable|main|master|nightly)$/);
      // Postgres versions are major.minor; everything else is major.minor.patch.
      expect(tag, name).toMatch(/^v?\d+\.\d+(\.\d+)?(-[a-z0-9.]+)?$/);
      expect(service.image, name).not.toContain("${");
    }
    expect(compose.services["mautrix-whatsapp"].image).toBe("dock.mau.dev/mautrix/whatsapp:v0.2610.0");
    expect(compose.services["mautrix-telegram"].image).toBe("dock.mau.dev/mautrix/telegram:v0.2610.0");
    expect(compose.services["mautrix-linkedin"].image).toBe("dock.mau.dev/mautrix/linkedin:v0.2609.0");
    expect(compose.services.synapse.image).toBe("ghcr.io/element-hq/synapse:v1.165.0");
    expect(compose.services.postgres.image).toBe("postgres:18.6-alpine3.24");
    expect(compose.services.caddy.image).toBe("caddy:2.11.8-alpine");
  });

  it("publishes only the proxy, and only on 80 and 443", () => {
    for (const [name, service] of services) {
      if (name === "caddy") continue;
      expect(service.ports, `${name} must not publish ports`).toBeUndefined();
    }
    const published = (compose.services.caddy.ports ?? []).map((port) => port.split(":").at(-1));
    expect(published.sort()).toEqual(["443", "80"]);
  });

  it("sets a restart policy and memory limit on every service", () => {
    for (const [name, service] of services) {
      expect(service.restart, name).toBe("unless-stopped");
      expect(service.mem_limit, name).toMatch(/^\d+[mg]$/);
    }
  });

  it("keeps the database on an internal-only network", () => {
    expect(compose.networks.db?.internal).toBe(true);
    expect(compose.services.postgres.networks).toEqual(["db"]);
    expect(compose.services.caddy.networks).not.toContain("db");
  });

  it("runs bridges unprivileged with read-only configs that the bridge never rewrites", () => {
    for (const name of bridgeServices) {
      const service = compose.services[name];
      expect(service.user, name).toBe("1337:1337");
      expect(service.read_only, name).toBe(true);
      expect(service.cap_drop, name).toEqual(["ALL"]);
      expect(service.security_opt, name).toContain("no-new-privileges:true");
      expect(service.command, name).toContain("--no-update");
      expect(service.volumes?.every((volume) => volume.endsWith(":ro")), name).toBe(true);
      expect(service.healthcheck?.test.join(" "), name).toContain("/_matrix/mau/live");
    }
    expect(compose.services.synapse.user).toBe("991:991");
  });

  it("reads the database superuser password from a file, never from inline env", () => {
    const env = compose.services.postgres.environment ?? {};
    expect(env.POSTGRES_PASSWORD).toBeUndefined();
    expect(env.POSTGRES_PASSWORD_FILE).toBeTruthy();
  });
});
