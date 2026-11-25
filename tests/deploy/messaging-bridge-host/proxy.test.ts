import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NETWORKS, TEST_INPUTS, makeStateDir, readSecret, removeDir, runBootstrap } from "./helpers.js";

/** Returns the body of the first `<prefix> {` block, brace-balanced. */
function block(source: string, prefix: string): string {
  const start = source.indexOf(`${prefix} {`);
  if (start < 0) throw new Error(`block not found: ${prefix}`);
  let depth = 0;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(source.indexOf("{", start) + 1, index);
    }
  }
  throw new Error(`unbalanced block: ${prefix}`);
}

function lines(body: string): string[] {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

describe("bridge host reverse proxy", () => {
  let state: string;
  let caddyfile: string;
  let gate: string;
  let site: string;

  beforeAll(() => {
    state = makeStateDir();
    const run = runBootstrap(state);
    expect(run.status).toBe(0);
    caddyfile = readFileSync(join(state, "caddy/Caddyfile"), "utf8");
    gate = readSecret(state, "gate-secret");
    site = block(caddyfile, TEST_INPUTS.MBH_PUBLIC_HOSTNAME);
  });
  afterAll(() => removeDir(state));

  it("serves one HTTPS site with automatic TLS and no admin endpoint", () => {
    expect(caddyfile).not.toContain("auto_https off");
    expect(caddyfile).not.toMatch(/^http:\/\//m);
    expect(caddyfile.startsWith("{\n")).toBe(true);
    expect(lines(caddyfile.slice(1, caddyfile.indexOf("\n}\n")))).toEqual(
      expect.arrayContaining([`email ${TEST_INPUTS.MBH_ACME_EMAIL}`, "admin off"]),
    );
    expect(site).toContain("Strict-Transport-Security");
  });

  it("generates a strong gate secret", () => {
    expect(gate).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gates the homeserver admin API and client login behind the platform secret", () => {
    expect(lines(block(site, "@platform_admin"))).toEqual([
      "path /_synapse/admin/* /_matrix/client/v3/login",
      `header X-Matrix-Bridge-Gate ${gate}`,
    ]);
    const handler = lines(block(site, "handle @platform_admin"));
    expect(handler).toEqual(["request_header -X-Matrix-Bridge-Gate", "reverse_proxy synapse:8008"]);
  });

  it.each(NETWORKS)("gates only the %s provisioning API, under a stable prefix", (network) => {
    expect(lines(block(site, `@platform_${network}`))).toEqual([
      `path /bridges/${network}/_matrix/provision/*`,
      `header X-Matrix-Bridge-Gate ${gate}`,
    ]);
    const handler = lines(block(site, `handle @platform_${network}`));
    expect(handler[0]).toBe("request_header -X-Matrix-Bridge-Gate");
    expect(handler).toContain(`uri strip_prefix /bridges/${network}`);
    expect(handler.at(-1)).toMatch(new RegExp(`^reverse_proxy mautrix-${network}:\\d+$`));
  });

  it("exposes only the client and media APIs without the gate, minus login and registration", () => {
    expect(lines(block(site, "@client"))).toEqual([
      "path /_matrix/client/* /_matrix/media/*",
      "not path_regexp ^/_matrix/client/[^/]+/(login|register)(/.*)?$",
    ]);
    const handler = lines(block(site, "handle @client"));
    expect(handler).toEqual(["request_header -X-Matrix-Bridge-Gate", "reverse_proxy synapse:8008"]);
  });

  it("blocks federation and answers 404 for everything else", () => {
    expect(site).toMatch(/@federation path \/_matrix\/federation\/\* \/_matrix\/key\/\* \/\.well-known\/matrix\/\*\n/);
    expect(lines(block(site, "handle @federation"))).toEqual(["respond 404"]);
    expect(lines(block(site, "handle"))).toEqual(["respond 404"]);
  });

  it("never routes to a bridge or the admin API except through a gated matcher", () => {
    const upstreams = site.match(/reverse_proxy \S+/g) ?? [];
    const bridgeUpstreams = upstreams.filter((upstream) => upstream.includes("mautrix-"));
    expect(bridgeUpstreams).toHaveLength(NETWORKS.length);
    expect(site.match(new RegExp(`header X-Matrix-Bridge-Gate ${gate}`, "g"))).toHaveLength(NETWORKS.length + 1);
    expect(site).not.toMatch(/\/_synapse\/client/);
  });

  it("does not write access logs that could capture the gate header", () => {
    expect(caddyfile).not.toMatch(/^\s*log\b/m);
  });
});
