// #3662: keep the SSH transport boundary real. Two disposable sshd instances
// stand for an alias before and after a repoint; the CLI fixture still writes
// through real OpenSSH/SCP. This is not a Windows runtime qualification.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMachineCore, runCoreCli } from "../../desktop/src/main/local-terminals/machine-core";

const exec = promisify(execFile);
const expected = "a".repeat(32);
let root: string;
const servers: ChildProcess[] = [];
let config: string;
let cliBinary: string;
let first: number;
let second: number;
let clientPublicKey: string;

async function sshd(home: string): Promise<number> {
  await mkdir(home, { recursive: true });
  const socket = createServer();
  await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const serverConfig = join(home, "sshd_config");
  await writeFile(serverConfig, [
    `Port ${port}`, "ListenAddress 127.0.0.1", `HostKey ${root}/host_key`,
    `AuthorizedKeysFile ${root}/client_key.pub`, "StrictModes no", "UsePAM no",
    "PasswordAuthentication no", "KbdInteractiveAuthentication no", "PubkeyAuthentication yes",
    "LogLevel VERBOSE", "Subsystem sftp /usr/lib/openssh/sftp-server", `PidFile ${home}/pid`,
  ].join("\n"));
  const child = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", serverConfig], { stdio: ["ignore", "ignore", "pipe"] });
  servers.push(child);
  return new Promise((resolve, reject) => {
    let log = "";
    const timer = setTimeout(() => reject(new Error(`sshd did not start: ${log}`)), 5_000);
    child.stderr!.on("data", (chunk) => {
      log = (log + chunk).slice(-8_192);
      const port = /Server listening on 127\.0\.0\.1 port (\d+)/.exec(log)?.[1];
      if (port) { clearTimeout(timer); resolve(Number(port)); }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(`sshd exited: ${log}`)); });
  });
}

async function pointAt(port: number, withJump = false) {
  await writeFile(config, [
    "Host box", ` Port ${port}`,
    ...(withJump ? ["Host jump", ` Port ${second}`] : []),
    "Host box jump", " HostName 127.0.0.1", ` User ${userInfo().username}`,
    ` IdentityFile ${root}/client_key`, " IdentitiesOnly yes",
    " StrictHostKeyChecking yes", ` UserKnownHostsFile ${root}/known_hosts`, "",
  ].join("\n"));
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "mx-3662-"));
  await chmod(root, 0o700);
  await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(root, "host_key")]);
  await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(root, "client_key")]);
  clientPublicKey = (await readFile(join(root, "client_key.pub"), "utf8")).trim();
  first = await sshd(join(root, "a"));
  second = await sshd(join(root, "b"));
  const key = (await readFile(join(root, "host_key.pub"), "utf8")).trim();
  await writeFile(join(root, "known_hosts"), `[127.0.0.1]:${first} ${key}\n[127.0.0.1]:${second} ${key}\n`);
  config = join(root, "ssh_config");
  cliBinary = join(root, "updater");
  // Herdr emits both its own -S and (on Windows) SCP's ControlPath option.
  // Neither may replace the verified connection. SCP writes a harmless fixture.
  await writeFile(cliBinary, `#!/bin/sh\nset -e\nssh -F "$FIXTURE_CONFIG" -S "$FIXTURE_ROOT/legacy" box 'printf updated > "$FIXTURE_MARKER"'\nif [ -n "\${FIXTURE_CLOSE_MASTER:-}" ]; then /usr/bin/ssh -S "$FIXTURE_CLOSE_MASTER" -O exit box; fi\nscp -q -F "$FIXTURE_CONFIG" -o "ControlPath=$FIXTURE_ROOT/legacy" "$FIXTURE_ROOT/payload" box:"$FIXTURE_UPLOAD"\n`);
  await chmod(cliBinary, 0o700);
  await writeFile(join(root, "payload"), "pinned core fixture");
}, 15_000);

afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => { server.once("close", () => resolve()); server.kill(); })));
  if (root) await rm(root, { recursive: true, force: true });
});

async function fixture(id: string | null = expected, layout: "local-bin" | "path" | "windows" = "local-bin") {
  await pointAt(first);
  const home = join(root, `remote-${layout}`);
  const bin = join(home, layout === "path" ? "bin" : ".local/bin");
  await mkdir(bin, { recursive: true });
  // The only Unix core is herdr-core in ~/.local/bin; there is no hc alias.
  await writeFile(join(bin, "herdr-core"), `#!/bin/sh\n[ "$*" = 'server status --json' ] || exit 2\nprintf '%s' '${JSON.stringify({ core: { ...(id ? { id } : {}) } })}'\n`);
  await chmod(join(bin, "herdr-core"), 0o700);
  const marker = join(root, "written");
  const upload = join(root, "uploaded");
  await rm(marker, { force: true });
  await rm(upload, { force: true });
  // Set HOME in the server-side command, without changing the runner's HOME.
  const ssh = join(root, "route");
  await writeFile(ssh, `#!/bin/sh\nexec /usr/bin/ssh -F '${config}' "$@"\n`);
  await chmod(ssh, 0o700);
  const env = {
    ...process.env, HOME: home, FIXTURE_ROOT: root, FIXTURE_CONFIG: config,
    FIXTURE_MARKER: marker, FIXTURE_UPLOAD: upload,
  } as Record<string, string>;
  // sshd accepts a forced command that sets up the fixture environment. This
  // preserves SSH connection/channel handling and execution of the real probe.
  const forced = join(root, "remote-shell");
  const windowsStatus = 'cmd /d /c ".\\AppData\\Local\\Programs\\herdr-core\\herdr-core.exe server status --json"';
  const windowsShell = layout === "windows" ? `
case "$SSH_ORIGINAL_COMMAND" in
  "sh -c "*) echo "sh is not recognized as an internal or external command" >&2; exit 127;;
  '${windowsStatus}') printf '%s' '${JSON.stringify({ core: { ...(id ? { id } : {}) } })}'; exit 0;;
esac
` : "";
  await writeFile(forced, `#!/bin/sh\nexport HOME='${home}' PATH='${layout === "path" ? bin + ":" : ""}/usr/bin:/bin' FIXTURE_MARKER='${marker}' XDG_STATE_HOME='${home}/state' XDG_CONFIG_HOME='${home}/config' XDG_RUNTIME_DIR='${home}/run'\nmkdir -p '${home}/run'\nchmod 700 '${home}/run'\nprintf '%s\\n' "$SSH_CONNECTION $SSH_ORIGINAL_COMMAND" >> '${root}/probes'\n${windowsShell}exec /bin/sh -c "$SSH_ORIGINAL_COMMAND"\n`);
  await chmod(forced, 0o700);
  const pub = clientPublicKey;
  // Reload each server's authorized-keys source via symlink-free config path.
  await writeFile(join(root, "client_key.pub"), `command="${forced}" ${pub}\n`);
  return { env, marker, upload, home, route: [ssh, "--", "box"] };
}

describe("machine update on one verified SSH connection", () => {
  it("aborts before the CLI or any upload when the expected ID is missing", async () => {
    const { env, marker } = await fixture();
    const core = createMachineCore({ cli: async () => ({ binary: cliBinary, env }) });
    expect(await core.update("box")).toEqual({ ok: false, reason: "changed" });
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([null, "../invalid", "b".repeat(32)])("aborts before writing for live ID %s", async (id) => {
    const { env, marker, upload, route } = await fixture(id);
    const core = createMachineCore({ cli: async () => ({ binary: cliBinary, env }) });
    expect(await core.update("box", { coreId: expected, ssh: route })).toEqual({ ok: false, reason: "changed" });
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(upload)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("pins SSH and SCP to the verified connection after the alias is repointed", async () => {
    const { env, marker, upload, route } = await fixture();
    // Both addresses are trusted and writable. The probe/upload/write must all
    // remain on the first server, even though the alias now names the second.
    const core = createMachineCore({
      cli: async () => ({ binary: cliBinary, env }),
      run: async (...args) => { await writeFile(join(root, "probes"), ""); await pointAt(second); await runCoreCli(...args); },
    });
    expect(await core.update("box", { coreId: expected, ssh: route })).toEqual({ ok: true });
    expect(await readFile(marker, "utf8")).toBe("updated");
    expect(await readFile(upload, "utf8")).toBe("pinned core fixture");
    const dials = (await readFile(join(root, "probes"), "utf8")).trim().split("\n");
    expect(dials.length).toBeGreaterThanOrEqual(2);
    expect(dials.every((line) => line.split(" ")[3] === String(first))).toBe(true);
  });

  it.each(["path", "windows"] as const)("updates the %s layout without a Unix hc alias", async (layout) => {
    const { env, marker, upload, route } = await fixture(expected, layout);
    const core = createMachineCore({ cli: async () => ({ binary: cliBinary, env }) });
    expect(await core.update("box", { coreId: expected, ssh: route })).toEqual({ ok: true });
    expect(await readFile(marker, "utf8")).toBe("updated");
    expect(await readFile(upload, "utf8")).toBe("pinned core fixture");
  });

  it("does not reconnect after the verified master dies, and cleans its private files", async () => {
    const { env, marker, upload, route } = await fixture();
    let privateDir = "";
    const core = createMachineCore({
      cli: async () => ({ binary: cliBinary, env }),
      run: async (binary, args, pinned, timeout) => {
        privateDir = dirname(pinned.HC_SSH!);
        await exec("/usr/bin/ssh", ["-S", join(privateDir, "control"), "-O", "exit", "box"]);
        await pointAt(second);
        await runCoreCli(binary, args, pinned, timeout);
      },
    });
    expect(await core.update("box", { coreId: expected, ssh: route })).toEqual({ ok: false, reason: "failed" });
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(upload)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(privateDir, "ssh"))).rejects.toMatchObject({ code: "ENOENT" });
  });


  it("does not let SCP reconnect if the master closes immediately before its upload", async () => {
    const { env, upload, route } = await fixture();
    const core = createMachineCore({
      cli: async () => ({ binary: cliBinary, env }),
      run: async (binary, args, pinned, timeout) => {
        await pointAt(second);
        await runCoreCli(binary, args, {
          ...pinned, FIXTURE_CLOSE_MASTER: join(dirname(pinned.HC_SSH!), "control"),
        }, timeout);
      },
    });
    expect(await core.update("box", { coreId: expected, ssh: route })).toEqual({ ok: false, reason: "failed" });
    await expect(readFile(upload)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["direct", "jump host"] as const)("runs the pinned Herdr updater on the verified %s route", async (kind) => {
    // Required for this explicit integration lane: no silently skipped proof.
    const binary = process.env.MATRIX_DESKTOP_HC_PATH;
    if (!binary) throw new Error("MATRIX_DESKTOP_HC_PATH must name the pinned Herdr 0.1.19 binary");
    const { env, home, route: fixtureRoute } = await fixture();
    const withJump = kind === "jump host";
    const jump = withJump ? ["-J", "jump"] : [];
    const route = [fixtureRoute[0]!, ...jump, "--", "box"];
    await pointAt(first, withJump);
    await copyFile(binary, join(home, ".local/bin/herdr-core"));
    await chmod(join(home, ".local/bin/herdr-core"), 0o700);
    const local = join(root, withJump ? "core-jump" : "core-direct");
    await mkdir(join(local, "run"), { recursive: true, mode: 0o700 });
    const localEnv = {
      ...env, HC_SESSION: "mx", XDG_STATE_HOME: join(local, "state"),
      XDG_CONFIG_HOME: join(local, "config"), XDG_RUNTIME_DIR: join(local, "run"),
    };
    const coreCli = (args: string[]) => exec(binary, args, { env: localEnv, timeout: 20_000 });
    try {
      await coreCli(["server", "start"]);
      const via = ["ssh", "-F", `'${config}'`, ...jump, "--", "box"].join(" ");
      const added = JSON.parse((await coreCli(["machine", "add", "--json", "--name", "box", "--via", via])).stdout);
      const core = createMachineCore({
        cli: async () => ({ binary, env: localEnv }),
        run: async (...args) => { await pointAt(second, withJump); await runCoreCli(...args); },
      });
      await writeFile(join(root, "probes"), "");
      expect(await core.update("box", { coreId: added.id, ssh: route })).toEqual({ ok: true });
      const dials = (await readFile(join(root, "probes"), "utf8")).trim().split("\n");
      expect(dials.some((line) => line.includes(".herdr-core.new"))).toBe(true);
      expect(dials.every((line) => line.split(" ")[3] === String(first))).toBe(true);
      expect((await coreCli(["machine", "ls", "--json"])).stdout).toContain(added.id);
    } finally {
      await coreCli(["server", "stop"]);
      await pointAt(first, withJump);
      // Stop only the fixture's remote core, under its private XDG paths.
      await exec(route[0]!, [...route.slice(1), `"${home}/.local/bin/herdr-core" server stop`], { env, timeout: 20_000 });
    }
  });

});
