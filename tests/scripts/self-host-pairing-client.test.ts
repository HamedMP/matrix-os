import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Fault detected: for an HTTP --join URL the installer checked one DNS answer
// for a private address, then fetch() resolved the name again, so a changed
// answer could send the join code to a public server (DNS rebinding).
const root = process.cwd();
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => { server.close(() => resolve()); });
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function clientSource(): string {
  const result = spawnSync("bash", ["-c", 'set -Eeuo pipefail\nsource "$INSTALLER"\npair_client_source'], {
    cwd: root, encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", INSTALLER: join(root, "scripts/install-server.sh"), MATRIX_INSTALL_SOURCE_ONLY: "1", MATRIX_INSTALL_NONINTERACTIVE: "1", MATRIX_NO_TELEMETRY: "1" },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

async function listen(host: string, port: number, handler: (path: string) => { status: number; body: unknown }) {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? "");
    request.resume();
    request.on("end", () => {
      const { status, body } = handler(request.url ?? "");
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
  });
  servers.push(server);
  server.listen(port, host);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { hits, port: address.port };
}

describe("self-host pairing client", () => {
  it("sends both pairing requests to the address it checked, even if the name resolves elsewhere later", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-pair-client-"));
    dirs.push(dir);
    const checked = await listen("127.0.0.1", 0, (path) => path.endsWith("/challenge")
      ? { status: 200, body: { primaryMachineId: "m1", ownerId: "o1", challengeId: "c1", nonce: "n1", revision: 1 } }
      : { status: 200, body: { primary: { name: "first", dnsName: "first.tail.ts.net" } } });
    // The "rebound" answer: same port on another loopback address.
    const rebound = await listen("127.0.0.2", checked.port, () => ({ status: 500, body: {} }));
    // The installer's private-address check uses dns/promises; connections use dns.lookup.
    const preload = join(dir, "dns-rebind.mjs");
    writeFileSync(preload, `import dns from "node:dns";
const original = dns.lookup;
dns.lookup = function (host, options, callback) {
  if (host !== "pair.test") return original.apply(this, arguments);
  const done = typeof options === "function" ? options : callback;
  const all = typeof options === "object" && options?.all;
  queueMicrotask(() => all ? done(null, [{ address: "127.0.0.2", family: 4 }]) : done(null, "127.0.0.2", 4));
};
dns.promises.lookup = async (host, options) => host === "pair.test" ? { address: "127.0.0.1", family: 4 } : original.call(dns, host, options);
`);
    const child = spawn(process.execPath, ["--import", preload, "--input-type=module", "-e", clientSource()], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        MATRIX_JOIN_URL: `http://pair.test:${checked.port}`,
        MATRIX_JOIN_CODE: "mxj_test",
        MATRIX_JOIN_IDENTITY_DIR: dir,
        MATRIX_JOIN_NAME: "second",
        MATRIX_JOIN_DNS_NAME: "second.tail.ts.net",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const [code] = await once(child, "exit");
    expect(code, stderr).toBe(0);
    expect(checked.hits).toEqual(["/api/system/private-network/pairing/challenge", "/api/system/private-network/pairing/complete"]);
    expect(rebound.hits).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "paired-primary.json"), "utf8"))).toMatchObject({ name: "first", url: `http://pair.test:${checked.port}` });
  });
});
