import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OWNED_MACHINE_ENV_KEYS,
  mergeHostEnv,
  nginxSite,
  parsePlatformUrl,
  validateMachineEnv,
  writeFileAtomic,
  writeMachineFiles,
} from "../../distro/customer-vps/host-bin/matrix-connect.mjs";

const SCRIPT = join(process.cwd(), "distro/customer-vps/host-bin/matrix-connect.mjs");
const SECRET = "s3cr3t-owned-token-0123456789abcdef0123456789";
const TUNNEL = "eyJhIjoidHVubmVsLXNlY3JldCJ9";

function machineEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = Object.fromEntries(OWNED_MACHINE_ENV_KEYS.map((key: string) => [key, "x"]));
  return {
    ...env,
    MATRIX_MACHINE_ID: "4f7c2d1e-5a6b-4c3d-8e9f-0a1b2c3d4e5f",
    MATRIX_HANDLE: "alice",
    MATRIX_RUNTIME_SLOT: "owned-0a1b2c3d",
    MATRIX_RUNTIME_TOKEN_EPOCH: "1",
    PLATFORM_INTERNAL_URL: "https://app.matrix-os.com",
    UPGRADE_TOKEN: SECRET,
    MATRIX_AUTH_TOKEN: SECRET,
    MATRIX_CODE_PROXY_TOKEN: SECRET,
    ...overrides,
  };
}

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

async function startServer(handler: Handler): Promise<{ server: Server; url: string; calls: string[] }> {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      calls.push(`${req.method} ${req.url}`);
      handler(req, body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}`, calls };
}

function json(res: ServerResponse, status: number, body?: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

function run(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH ?? "", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe("matrix-connect", () => {
  let dir: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "matrix-connect-"));
    env = {
      MATRIX_CONNECT_ETC_DIR: join(dir, "etc"),
      MATRIX_CONNECT_HOST_ENV: join(dir, "env/host.env"),
      MATRIX_CONNECT_ENV_DIR: join(dir, "env"),
      MATRIX_CONNECT_STATE_DIR: join(dir, "state"),
      MATRIX_CONNECT_NGINX_SITE: join(dir, "nginx/site"),
      MATRIX_CONNECT_NGINX_ENABLED: join(dir, "nginx/enabled"),
      MATRIX_CONNECT_UNIT_SRC: join(dir, "units-src"),
      MATRIX_CONNECT_UNIT_DST: join(dir, "units-dst"),
      MATRIX_CONNECT_OS_RELEASE: join(dir, "os-release"),
      MATRIX_CONNECT_BUNDLE_VERSION_FILE: join(dir, "BUNDLE_VERSION"),
      MATRIX_CONNECT_SYSTEMCTL: "/bin/true",
      MATRIX_CONNECT_ARCH: "x64",
      MATRIX_CONNECT_TEST_FAST: "1",
      MATRIX_CONNECT_NO_ACTIVATE: "1",
      MATRIX_CONNECT_HEALTH_URL: "http://127.0.0.1:9/health",
    };
    await writeFile(join(dir, "os-release"), 'PRETTY_NAME="Ubuntu 24.04 LTS"\n');
    await writeFile(join(dir, "BUNDLE_VERSION"), "2026.11.22\n");
  });

  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("merges owned keys into host.env and keeps every other line", () => {
    const merged = mergeHostEnv("DATABASE_URL=postgres://x\nUPGRADE_TOKEN=old\nMATRIX_SELF_HOSTED=1\n", machineEnv());
    expect(merged).toContain("DATABASE_URL=postgres://x\n");
    expect(merged).toContain("MATRIX_SELF_HOSTED=1\n");
    expect(merged).not.toContain("UPGRADE_TOKEN=old");
    expect(merged.match(/^UPGRADE_TOKEN=/gm)).toHaveLength(1);
  });

  it("rejects unknown keys, shell metacharacters and non-https platforms", () => {
    expect(() => validateMachineEnv({ ...machineEnv(), DATABASE_URL: "x" })).toThrow();
    expect(() => validateMachineEnv(machineEnv({ MATRIX_HANDLE: "a$(id)" }))).toThrow();
    expect(() => validateMachineEnv(machineEnv({ MATRIX_HANDLE: "a\nB=1" }))).toThrow();
    expect(() => validateMachineEnv(machineEnv({ PLATFORM_INTERNAL_URL: "http://evil" }))).toThrow();
    expect(() => parsePlatformUrl("http://app.matrix-os.com")).toThrow();
    expect(parsePlatformUrl("https://app.matrix-os.com/")).toBe("https://app.matrix-os.com");
  });

  it("writes secret files with mode 0600 and an authenticated loopback nginx site", async () => {
    await writeFile(join(dir, "host.env.seed"), "");
    await writeMachineFiles(machineEnv(), TUNNEL, {
      machineEnv: join(dir, "etc/owned-machine.env"), tunnelToken: join(dir, "etc/cloudflared.token"),
      hostEnv: join(dir, "env/host.env"), envDir: join(dir, "env"), state: join(dir, "state/state.json"),
      nginxSite: join(dir, "nginx/site"), nginxEnabled: join(dir, "nginx/enabled"),
      unitSrc: dir, unitDst: dir, bundleVersion: dir, osRelease: dir,
    });
    expect((await stat(join(dir, "etc/owned-machine.env"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "etc/cloudflared.token"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "env/host.env"))).mode & 0o777).toBe(0o640);
    expect(await readFile(join(dir, "etc/cloudflared.token"), "utf8")).toBe(`${TUNNEL}\n`);
    const site = nginxSite(machineEnv());
    expect(site).toContain("listen 127.0.0.1:8790;");
    expect(site).toContain("return 401;");
    expect(site).not.toContain("auth_basic");
  });

  it("enrolls through pending and slow_down to ready without printing secrets", async () => {
    let polls = 0;
    const { server, url, calls } = await startServer((req, body, res) => {
      if (req.url === "/api/machines/enroll/start") {
        expect(JSON.parse(body)).toMatchObject({ arch: "x86_64", os: "Ubuntu 24.04 LTS", agentVersion: "2026.11.22" });
        return json(res, 200, {
          deviceCode: "a".repeat(43), userCode: "BCDF-GHJK", verificationUri: `${url}/connect`,
          // A different origin must never be printed: the link is built from --platform.
          verificationUriComplete: "https://elsewhere.example/connect?code=BCDFGHJK", expiresIn: 900, interval: 1,
        });
      }
      polls += 1;
      if (polls === 1) return json(res, 200, { status: "pending" });
      if (polls === 2) return json(res, 200, { status: "slow_down" });
      return json(res, 200, { status: "ready", machineId: machineEnv().MATRIX_MACHINE_ID, tunnelToken: TUNNEL, env: machineEnv() });
    });
    try {
      const result = await run(["enroll", "--platform", url], env);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("BCDF-GHJK");
      expect(result.stdout).toContain(`Open ${url}/connect?code=BCDF-GHJK`);
      expect(result.stdout).not.toContain("elsewhere.example");
      expect(result.stdout).toContain("Connected.");
      expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET);
      expect(`${result.stdout}${result.stderr}`).not.toContain(TUNNEL);
      expect(calls.filter((c) => c.endsWith("/poll"))).toHaveLength(3);
      expect(await readFile(join(dir, "env/host.env"), "utf8")).toContain(`UPGRADE_TOKEN=${SECRET}`);
      expect((await stat(join(dir, "state/state.json"))).mode & 0o777).toBe(0o600);
    } finally {
      server.close();
    }
  });

  it("stops reading an oversized response without Content-Length and reports the platform unavailable", async () => {
    // The fake platform streams forever. A connector that buffers the whole
    // body keeps reading until its request timeout; a capped reader cancels
    // after 64 KiB, so the stream stops early and the command returns quickly.
    let written = 0;
    let stopped = false;
    const { server, url } = await startServer((_req, _body, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(16 * 1024, 0x61);
      const pump = () => {
        while (!stopped) {
          written += chunk.length;
          if (!res.write(chunk)) { res.once("drain", pump); return; }
        }
      };
      res.on("close", () => { stopped = true; });
      pump();
    });
    try {
      const started = Date.now();
      const result = await run(["enroll", "--platform", url], env);
      expect(result.code).toBe(3);
      expect(result.stderr).toContain("platform unavailable");
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(written).toBeLessThan(16 * 1024 * 1024);
    } finally {
      stopped = true;
      server.close();
    }
  });

  it.each([["expired"], ["denied"]])("exits 2 when the code is %s", async (status) => {
    const { server, url } = await startServer((req, _body, res) => {
      if (req.url === "/api/machines/enroll/start") {
        return json(res, 200, {
          deviceCode: "b".repeat(43), userCode: "BCDF-GHJK", verificationUri: `${url}/connect`,
          verificationUriComplete: `${url}/connect`, expiresIn: 900, interval: 1,
        });
      }
      return json(res, 200, { status });
    });
    try {
      expect((await run(["enroll", "--platform", url], env)).code).toBe(2);
    } finally {
      server.close();
    }
  });

  it("refuses a ready answer that carries a non-allowlisted key", async () => {
    const { server, url } = await startServer((req, _body, res) => {
      if (req.url === "/api/machines/enroll/start") {
        return json(res, 200, {
          deviceCode: "c".repeat(43), userCode: "BCDF-GHJK", verificationUri: `${url}/connect`,
          verificationUriComplete: `${url}/connect`, expiresIn: 900, interval: 1,
        });
      }
      return json(res, 200, { status: "ready", machineId: "x", tunnelToken: TUNNEL, env: { ...machineEnv(), DATABASE_URL: "x" } });
    });
    try {
      expect((await run(["enroll", "--platform", url], env)).code).toBe(3);
      await expect(stat(join(dir, "etc/owned-machine.env"))).rejects.toThrow();
    } finally {
      server.close();
    }
  });

  async function connectFiles(platform: string): Promise<void> {
    await writeMachineFiles(machineEnv(), TUNNEL, {
      machineEnv: join(dir, "etc/owned-machine.env"), tunnelToken: join(dir, "etc/cloudflared.token"),
      hostEnv: join(dir, "env/host.env"), envDir: join(dir, "env"), state: join(dir, "state/state.json"),
      nginxSite: join(dir, "nginx/site"), nginxEnabled: join(dir, "nginx/enabled"),
      unitSrc: dir, unitDst: dir, bundleVersion: dir, osRelease: dir,
    });
    await mkdir(join(dir, "state"), { recursive: true });
    await writeFile(join(dir, "state/state.json"), JSON.stringify({ platformUrl: platform }), { mode: 0o600 });
  }

  it("stops with exit 4 when the platform revokes the machine", async () => {
    const { server, url, calls } = await startServer((req, _body, res) => {
      expect(req.headers.authorization).toBe(`Bearer ${SECRET}`);
      expect(req.headers["x-matrix-machine-id"]).toBe(machineEnv().MATRIX_MACHINE_ID);
      json(res, 401, { error: "unauthorized" });
    });
    try {
      await connectFiles(url);
      const result = await run(["heartbeat"], env);
      expect(result.code).toBe(4);
      expect(calls).toEqual(["POST /api/machines/heartbeat"]);
      expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET);
    } finally {
      server.close();
    }
  });

  it("fetches a new tunnel token when the platform asks for a reissue", async () => {
    const { server, url } = await startServer((req, _body, res) => {
      if (req.url === "/api/machines/heartbeat") {
        return json(res, 200, { status: "ok", tunnel: "reissue", autoSecurityUpdates: true, backupsEnabled: false });
      }
      return json(res, 200, { tunnelToken: "bmV3LXR1bm5lbA" });
    });
    try {
      await connectFiles(url);
      const result = await run(["heartbeat"], { ...env, MATRIX_CONNECT_MAX_BEATS: "1" });
      expect(result.code).toBe(0);
      expect(await readFile(join(dir, "etc/cloudflared.token"), "utf8")).toBe("bmV3LXR1bm5lbA\n");
      const status = await run(["status"], env);
      expect(status.stdout).toContain("Status: connected");
      expect(status.stdout).not.toContain(SECRET);
    } finally {
      server.close();
    }
  });

  it("keeps retrying a pending reissue after the platform reports the tunnel ok", async () => {
    let tunnelCalls = 0;
    let beats = 0;
    const { server, url } = await startServer((req, _body, res) => {
      if (req.url === "/api/machines/heartbeat") {
        beats += 1;
        return json(res, 200, { status: "ok", tunnel: beats === 1 ? "reissue" : "ok", autoSecurityUpdates: true, backupsEnabled: false });
      }
      tunnelCalls += 1;
      if (tunnelCalls === 1) return json(res, 202, { status: "pending" });
      return json(res, 200, { tunnelToken: "cmVwbGFjZWQ" });
    });
    try {
      await connectFiles(url);
      const result = await run(["heartbeat"], { ...env, MATRIX_CONNECT_MAX_BEATS: "2" });
      expect(result.code).toBe(0);
      expect(tunnelCalls).toBe(2);
      expect(await readFile(join(dir, "etc/cloudflared.token"), "utf8")).toBe("cmVwbGFjZWQ\n");
      const state = JSON.parse(await readFile(join(dir, "state/state.json"), "utf8"));
      expect(state.pendingTunnelReissue).toBe(false);
    } finally {
      server.close();
    }
  });

  it("fails enrollment loudly when a service cannot start", async () => {
    const { server, url } = await startServer((req, _body, res) => {
      if (req.url === "/api/machines/enroll/start") {
        return json(res, 200, {
          deviceCode: "d".repeat(43), userCode: "BCDF-GHJK", verificationUri: `${url}/connect`,
          verificationUriComplete: `${url}/connect`, expiresIn: 900, interval: 1,
        });
      }
      return json(res, 200, { status: "ready", machineId: machineEnv().MATRIX_MACHINE_ID, tunnelToken: TUNNEL, env: machineEnv() });
    });
    try {
      const { MATRIX_CONNECT_NO_ACTIVATE: _skip, ...activating } = env;
      await mkdir(join(dir, "nginx"), { recursive: true });
      const result = await run(["enroll", "--platform", url], { ...activating, MATRIX_CONNECT_SYSTEMCTL: "/bin/false" });
      expect(result.code).not.toBe(0);
      expect(result.stdout).not.toContain("Connected.");
      expect(result.stderr).toContain("matrix-connect refresh");
    } finally {
      server.close();
    }
  });

  it("removes its temporary file when a write fails", async () => {
    const target = join(dir, "atomic/secret");
    await expect(writeFileAtomic(target, 42 as unknown as string, { mode: 0o600 })).rejects.toThrow();
    expect((await readdir(join(dir, "atomic"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("disconnects, removing secrets even when the platform is unreachable", async () => {
    await connectFiles("http://127.0.0.1:9");
    const result = await run(["disconnect"], env);
    expect(result.code).toBe(0);
    await expect(stat(join(dir, "etc/owned-machine.env"))).rejects.toThrow();
    await expect(stat(join(dir, "etc/cloudflared.token"))).rejects.toThrow();
  });
});

describe("install-server.sh --connect", () => {
  const script = join(process.cwd(), "scripts/install-server.sh");

  it("prints usage and rejects unknown options before touching the system", () => {
    const help = spawnSync("bash", [script, "--help"], { env: { ...process.env, MATRIX_NO_TELEMETRY: "1" }, encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--connect");
    const bad = spawnSync("bash", [script, "--bogus"], { env: { ...process.env, MATRIX_NO_TELEMETRY: "1" }, encoding: "utf8" });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("unknown option");
  });

  it("connects only after verification and keeps an existing connection on reinstall", async () => {
    const text = await readFile(script, "utf8");
    expect(text.indexOf('INSTALL_PHASE="connect"')).toBeGreaterThan(text.indexOf('INSTALL_PHASE="verify"'));
    expect(text).toContain("/opt/matrix/bin/matrix-install-connect");
    expect(text).toContain('/usr/local/bin/matrix-connect enroll --platform "$MATRIX_PLATFORM_URL"');
    expect(text).toContain("/usr/local/bin/matrix-connect refresh");
    expect(text).toContain("--platform-url must be an https origin");
  });
});

describe("owned machine units", () => {
  it("runs the tunnel unprivileged with the token as a systemd credential", async () => {
    const unit = await readFile(join(process.cwd(), "distro/customer-vps/systemd/matrix-cloudflared.service"), "utf8");
    expect(unit).toContain("DynamicUser=yes");
    expect(unit).toContain("LoadCredential=tunnel-token:/etc/matrix/cloudflared.token");
    expect(unit).toContain("--no-autoupdate run --token-file");
    expect(unit).not.toMatch(/--token [^-]/);
  });

  it("does not restart a revoked heartbeat and runs root code only from root-owned paths", async () => {
    const unit = await readFile(join(process.cwd(), "distro/customer-vps/systemd/matrix-connect.service"), "utf8");
    expect(unit).toContain("RestartPreventExitStatus=4");
    expect(unit).toContain("ExecStart=/usr/local/libexec/matrix-connect/node /usr/local/libexec/matrix-connect/matrix-connect.mjs heartbeat");
    expect(unit).not.toContain("/opt/matrix/runtime/node");
  });

  it("verifies the pinned cloudflared checksum before installing it", async () => {
    const installer = await readFile(join(process.cwd(), "distro/customer-vps/host-bin/matrix-install-connect"), "utf8");
    expect(installer).toContain('CLOUDFLARED_VERSION="2025.11.1"');
    expect(installer).toContain("--max-time 30");
    expect(installer).toContain('fail "cloudflared checksum mismatch"');
    expect(installer).toContain('install -o root -g root -m 0755 "$NODE_SRC" "$LIBEXEC/node"');
  });
});
