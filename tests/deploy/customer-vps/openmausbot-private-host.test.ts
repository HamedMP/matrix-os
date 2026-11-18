import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error The build patch is a standalone Node script.
import { patchPrivateHost } from "../../../scripts/openmausbot/apply-private-host.mjs";

describe("OpenMausBot Matrix Computer workload", () => {
  it("keeps the upstream tunnel auth and confines local commissioning to a separate socket", () => {
    const sample = [
      'import { existsSync, realpathSync, rmSync } from "node:fs";',
      'import { basename, join } from "node:path";',
      'if (HOSTED_WORKSPACE) setDefaultApprovalMode("ask");',
      '        const custom = await mcpServersHost.prepare(bot).then(() => teamConnections.turnMcp(bot, threadId, dispatchClaimId));',
      'const TUNNEL_SOCKET = process.env.OMB_TUNNEL_SOCKET?.trim() || null;',
      '    console.log(`openmausbot tunnel listener on ${TUNNEL_SOCKET}`);',
      '  });',
      '}',
      '      tunnelListener?.close(); stopCloudHomeConnectedApps();',
    ].join("\n");
    const patched = patchPrivateHost(sample);
    expect(patched).toContain('if (HOSTED_WORKSPACE || process.env.OMB_MATRIX_PAIR_SOCKET) setDefaultApprovalMode("ask");');
    expect(patched).toContain('process.env.OMB_MATRIX_DRIVE_MCP === "1" && personLine');
    expect(patched).toContain('opts?.trigger?.kind === "user"');
    expect(patched).toContain('args: ["/opt/openmausbot/matrix-drive-mcp.mjs"], env: {}');
    expect(patched).toContain('req.method !== "POST" || req.url !== "/pairing"');
    expect(patched).toContain('chmodSync(pairSocket, 0o600)');
    expect(patched).toContain("matrixTimingSafeEqual(expectedProof, Buffer.from(presented[1]!))");
    expect(patched).toContain("process.stdin.destroy()");
    expect(patched).toContain('sessions.openPairing({ label: "Matrix Computer", ttlMs: 5 * 60_000 })');
    expect(patched).toContain('tunnelListener?.close(); matrixPairingListener?.close();');
    expect(() => patchPrivateHost(patched)).toThrow(/pinned source/);
  });

  it("packages and runs the workload without host ports or the Docker socket", async () => {
    const [bundle, unit, runtime, workflow, gatewayUnit] = await Promise.all([
      readFile("scripts/build-host-bundle.sh", "utf8"),
      readFile("scripts/openmausbot/matrix-openmausbot.service", "utf8"),
      readFile("scripts/openmausbot/matrix-openmausbot-run", "utf8"),
      readFile(".github/workflows/preview-vps.yml", "utf8"),
      readFile("distro/customer-vps/systemd/matrix-gateway.service", "utf8"),
    ]);
    expect(bundle).not.toContain("HOST_BUNDLE_OPENMAUSBOT_PREVIEW");
    expect(workflow).not.toContain("openmausbot-preview");
    expect(gatewayUnit).toMatch(/^Wants=.*matrix-openmausbot\.service$/m);
    expect(bundle).toContain('install -m 0755 "$ROOT_DIR/scripts/openmausbot/matrix-openmausbot-run"');
    expect(bundle).toContain('install -m 0644 "$ROOT_DIR/scripts/openmausbot/matrix-openmausbot.service"');
    expect(bundle).toContain('chmod 0644 "$OPENMAUSBOT_IMAGE_ARCHIVE" "$STAGE_DIR/bin/matrix-openmausbot.image-ref"');
    expect(unit).not.toContain("MATRIX_OPENMAUSBOT_PREVIEW");
    expect(unit).toContain("ConditionPathExists=/opt/matrix/bin/matrix-openmausbot.image-ref");
    expect(unit).toContain("StateDirectory=matrix-openmausbot");
    expect(runtime).toContain('"$docker" run --rm --pull=never');
    expect(runtime).toContain('--network "$network"');
    expect(runtime).toContain("--cap-drop=ALL");
    expect(runtime).toContain("--security-opt=no-new-privileges");
    expect(runtime).toContain('iptables -I INPUT 1 -i "$bridge" -j REJECT');
    expect(runtime).toContain('iptables -I DOCKER-USER 1 -i "$bridge" -j "$chain"');
    expect(runtime).toContain("169.254.0.0/16");
    expect(runtime).not.toMatch(/--network[= ]host|--publish|--privileged|\/var\/run\/docker\.sock/);
  });

  it("requires protected, exact-build metadata and a nonempty image archive before startup", async () => {
    const runtime = await readFile("scripts/openmausbot/matrix-openmausbot-run", "utf8");
    const temp = await mkdtemp(join(tmpdir(), "openmausbot-host-admission-"));
    try {
      const launcher = join(temp, "launcher");
      const ref = join(temp, "matrix-openmausbot.image-ref");
      const archive = join(temp, "matrix-openmausbot.image.tar");
      // The launcher runs on Linux. Supply fixture ownership and portable stat
      // output without substituting the admission or permissions logic.
      await writeFile(launcher, runtime.replace("readonly image_dir=/opt/matrix/bin", "readonly image_dir=" + temp));
      const statMode = process.platform === "darwin" ? '/usr/bin/stat -f %Lp "$4"' : '/usr/bin/stat -c %a -- "$4"';
      const command = 'stat() { printf "%s %s\n" "$FIXTURE_UID" "$(' + statMode + ')"; }; source "$1" --admit';
      const status = (uid = "0") => spawnSync("bash", ["-c", command, "bash", launcher], {
        env: { ...process.env, FIXTURE_UID: uid },
      }).status;
      const image = "matrix-openmausbot-oss:matrix-" + "a".repeat(40);
      expect(status()).toBe(1);
      await writeFile(ref, image + "\n", { mode: 0o644 });
      expect(status()).toBe(1);
      await writeFile(archive, "fixture", { mode: 0o644 });
      expect(status()).toBe(0);
      expect(status("1000")).toBe(1);
      await chmod(ref, 0o666);
      expect(status()).toBe(1);
      await chmod(ref, 0o644);
      await writeFile(ref, "invalid-build\n");
      expect(status()).toBe(1);
      await writeFile(ref, image + "\n");
      await rm(archive);
      await writeFile(archive, "", { mode: 0o644 });
      expect(status()).toBe(1);
      await rm(archive);
      await symlink(ref, archive);
      expect(status()).toBe(1);
    } finally {
      await rm(temp, { force: true, recursive: true });
    }
  });

  it("loads the tagged archive and checks its build label across Docker image stores", async () => {
    const [build, runtime] = await Promise.all([
      readFile("scripts/openmausbot/build-host-image.mjs", "utf8"),
      readFile("scripts/openmausbot/matrix-openmausbot-run", "utf8"),
    ]);
    expect(build).toContain('run("docker", ["save", "--output", archive, image])');
    expect(build).toContain('"--tag", image');
    expect(build).toContain('"--label", "org.matrix-os.openmausbot.bundle-sha=" + sha');
    expect(build).not.toContain("--iidfile");
    const check = runtime.match(/^matches_release\(\) \{\n[\s\S]*?^\}/m)?.[0];
    expect(check).toBeDefined();
    const sha = "a".repeat(40);
    for (const [label, expected] of [[sha, 0], ["b".repeat(40), 1], ["", 1]] as const) {
      const result = spawnSync("bash", ["-c", `image="$1"; docker=fake_docker
fake_docker() { [[ "$1 $2" = "image inspect" && "$5" = "$image" && -n "$_LABEL" ]] || return 1; printf '%s\\n' "$_LABEL"; }
${check}
matches_release`, "bash", `matrix-openmausbot-oss:matrix-${sha}`], { env: { ...process.env, _LABEL: label } });
      expect(result.status).toBe(expected);
    }
  });
});
