import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { BUNDLE_DIR, makeStateDir, mode, removeDir } from "./helpers.js";

const BACKUP = join(BUNDLE_DIR, "backup.sh");
const HEALTH = join(BUNDLE_DIR, "health.sh");

function daysAgo(path: string, days: number): void {
  const when = new Date(Date.now() - days * 86_400_000);
  utimesSync(path, when, when);
}

function tarList(archive: string): string {
  const result = spawnSync("tar", ["-tvzf", archive], { encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout;
}

describe("backup.sh", () => {
  it("is strict, locked and symlink-safe by construction", () => {
    const script = readFileSync(BACKUP, "utf8");
    expect(script).toMatch(/^#!\/usr\/bin\/env bash\n/);
    expect(script).toContain("set -eu");
    expect(script).toContain("umask 077");
    expect(script).toContain("flock");
    expect(script).not.toMatch(/set -[a-z]*x/);
    expect(statSync(BACKUP).mode & 0o111).not.toBe(0);
  });

  it("archives state without following symlinks and rotates only real backup directories", () => {
    const work = makeStateDir();
    try {
      const state = join(work, "state");
      const root = join(work, "backups");
      const outside = join(work, "outside");
      mkdirSync(join(state, "secrets"), { recursive: true, mode: 0o700 });
      mkdirSync(join(state, "postgres/data"), { recursive: true });
      mkdirSync(join(state, "synapse/media_store"), { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(state, "secrets/gate-secret"), "gate\n", { mode: 0o600 });
      writeFileSync(join(state, "postgres/data/PG_VERSION"), "18\n");
      writeFileSync(join(state, "synapse/media_store/blob"), "media\n");
      writeFileSync(join(outside, "precious"), "do-not-copy-or-delete\n");
      symlinkSync(join(outside, "precious"), join(state, "secrets/link-to-outside"));

      mkdirSync(root, { recursive: true, mode: 0o700 });
      const expired = join(root, "20260101T000000Z");
      const recent = join(root, "20990101T000000Z");
      mkdirSync(expired);
      mkdirSync(recent);
      writeFileSync(join(expired, "state.tar.gz"), "old");
      daysAgo(expired, 10);
      daysAgo(recent, 2);
      const trap = join(root, "20250101T000000Z");
      symlinkSync(outside, trap);

      const run = spawnSync("bash", [BACKUP], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          MBH_STATE_DIR: state,
          MBH_BACKUP_ROOT: root,
          MBH_BACKUP_DATABASES: "",
        },
      });
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      const report = JSON.parse(run.stdout.trim()) as { backup: string; path: string; databases: string[] };
      expect(report.backup).toBe("ok");
      expect(report.databases).toEqual([]);

      expect(existsSync(expired)).toBe(false);
      expect(existsSync(recent)).toBe(true);
      expect(lstatSync(trap).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(outside, "precious"), "utf8")).toBe("do-not-copy-or-delete\n");

      const created = readdirSync(root).filter((name) => ![".lock", "20990101T000000Z", "20250101T000000Z"].includes(name));
      expect(created).toHaveLength(1);
      const dest = join(root, created[0]);
      expect(dest).toBe(report.path);
      expect(mode(dest)).toBe(0o700);
      expect(mode(join(dest, "state.tar.gz"))).toBe(0o600);
      const listing = tarList(join(dest, "state.tar.gz"));
      expect(listing).toMatch(/secrets\/link-to-outside -> /);
      expect(listing).toContain("secrets/gate-secret");
      expect(listing).not.toContain("postgres/data");
      expect(listing).not.toContain("media_store/blob");
    } finally {
      removeDir(work);
    }
  });

  it("refuses a backup root that is a symlink", () => {
    const work = makeStateDir();
    try {
      mkdirSync(join(work, "state"));
      mkdirSync(join(work, "real"));
      symlinkSync(join(work, "real"), join(work, "backups"));
      const run = spawnSync("bash", [BACKUP], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          MBH_STATE_DIR: join(work, "state"),
          MBH_BACKUP_ROOT: join(work, "backups"),
          MBH_BACKUP_DATABASES: "",
        },
      });
      expect(run.status).not.toBe(0);
      expect(readdirSync(join(work, "real"))).toEqual([]);
    } finally {
      removeDir(work);
    }
  });
});

describe("health.sh", () => {
  function runHealth(states: Record<string, string>): { status: number | null; json: Record<string, unknown> } {
    const work = makeStateDir();
    try {
      const bin = join(work, "bin");
      mkdirSync(bin);
      const stub = [
        "#!/usr/bin/env bash",
        'if [ "$1" = compose ]; then',
        '  service="${*: -1}"',
        '  var="STUB_${service//-/_}"',
        '  if [ -n "${!var:-}" ]; then printf "id-%s\\n" "$service"; fi',
        "  exit 0",
        "fi",
        'if [ "$1" = inspect ]; then',
        '  service="${*: -1}"; service="${service#id-}"',
        '  var="STUB_${service//-/_}"',
        '  printf "%s\\n" "${!var}"',
        "  exit 0",
        "fi",
        "exit 2",
      ].join("\n");
      writeFileSync(join(bin, "docker"), stub);
      chmodSync(join(bin, "docker"), 0o755);
      const env: Record<string, string> = {
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        MBH_STATE_DIR: work,
      };
      for (const [service, value] of Object.entries(states)) env[`STUB_${service.replaceAll("-", "_")}`] = value;
      const run = spawnSync("bash", [HEALTH], { encoding: "utf8", env });
      expect(run.stderr).toBe("");
      return { status: run.status, json: JSON.parse(run.stdout.trim()) as Record<string, unknown> };
    } finally {
      removeDir(work);
    }
  }

  const allHealthy = {
    postgres: "running healthy",
    synapse: "running healthy",
    "mautrix-whatsapp": "running healthy",
    "mautrix-telegram": "running healthy",
    "mautrix-linkedin": "running healthy",
    caddy: "running none",
  };

  it("reports ok with coarse per-service states", () => {
    const { status, json } = runHealth(allHealthy);
    expect(status).toBe(0);
    expect(json).toEqual({
      status: "ok",
      services: {
        postgres: "healthy",
        synapse: "healthy",
        "mautrix-whatsapp": "healthy",
        "mautrix-telegram": "healthy",
        "mautrix-linkedin": "healthy",
        caddy: "running",
      },
      client_api: null,
    });
  });

  it("reports degraded when any service is unhealthy or missing", () => {
    const { status, json } = runHealth({ ...allHealthy, "mautrix-telegram": "running unhealthy", "mautrix-linkedin": "" });
    expect(status).toBe(1);
    expect(json.status).toBe("degraded");
    expect(json.services).toMatchObject({ "mautrix-telegram": "unhealthy", "mautrix-linkedin": "missing" });
  });

  it("maps a stopped container to stopped", () => {
    const { json } = runHealth({ ...allHealthy, caddy: "exited none" });
    expect(json.services).toMatchObject({ caddy: "stopped" });
  });
});

describe("cloud-init", () => {
  const raw = readFileSync(join(BUNDLE_DIR, "cloud-init.yaml"), "utf8");
  const config = parse(raw) as {
    packages: string[];
    runcmd: (string | string[])[];
    write_files: { path: string; content: string; permissions?: string }[];
    package_update: boolean;
    package_upgrade: boolean;
  };
  const commands = config.runcmd.map((entry) => (Array.isArray(entry) ? entry.join(" ") : entry));

  it("is a cloud-config document that installs Docker, the firewall and unattended upgrades", () => {
    expect(raw.startsWith("#cloud-config\n")).toBe(true);
    expect(config.package_update).toBe(true);
    for (const pkg of ["docker.io", "docker-compose-v2", "ufw", "unattended-upgrades"]) {
      expect(config.packages).toContain(pkg);
    }
    const autoUpgrades = config.write_files.find((file) => file.path === "/etc/apt/apt.conf.d/20auto-upgrades");
    expect(autoUpgrades?.content).toContain('APT::Periodic::Unattended-Upgrade "1";');
  });

  it("allows only SSH, HTTP and HTTPS inbound", () => {
    expect(commands).toContain("ufw default deny incoming");
    const allows = commands.filter((command) => command.startsWith("ufw allow"));
    expect(allows.sort()).toEqual(["ufw allow 22/tcp", "ufw allow 443/tcp", "ufw allow 80/tcp"]);
    expect(commands).toContain("ufw --force enable");
  });

  it("disables SSH password login", () => {
    const sshd = config.write_files.find((file) => file.path.startsWith("/etc/ssh/sshd_config.d/"));
    expect(sshd?.content).toContain("PasswordAuthentication no");
  });

  it("embeds no secrets and does not run bootstrap", () => {
    expect(raw).not.toMatch(/(as_token|hs_token|shared_secret|PASSWORD=|_TOKEN=|api_hash)/i);
    expect(commands.join("\n")).not.toContain("bootstrap.sh");
  });
});

describe("backup systemd units", () => {
  it("runs the backup nightly from a persistent timer", () => {
    const timer = readFileSync(join(BUNDLE_DIR, "systemd/matrix-bridge-host-backup.timer"), "utf8");
    const service = readFileSync(join(BUNDLE_DIR, "systemd/matrix-bridge-host-backup.service"), "utf8");
    expect(timer).toMatch(/^OnCalendar=\*-\*-\* 0\d:\d\d:00$/m);
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("Unit=matrix-bridge-host-backup.service");
    expect(timer).toContain("WantedBy=timers.target");
    expect(service).toContain("Type=oneshot");
    expect(service).toContain("ExecStart=/opt/matrix-bridge-host/backup.sh");
    expect(service).toContain("UMask=0077");
  });
});
