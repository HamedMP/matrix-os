import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error The build patch is a standalone Node script.
import { patchPrivateHost } from "../../../scripts/openmausbot/apply-private-host.mjs";

describe("OpenMausBot Private Preview workload", () => {
  it("keeps the upstream tunnel auth and confines local commissioning to a separate socket", () => {
    const sample = [
      'import { existsSync, realpathSync, rmSync } from "node:fs";',
      'import { basename, join } from "node:path";',
      'if (HOSTED_WORKSPACE) setDefaultApprovalMode("ask");',
      'const TUNNEL_SOCKET = process.env.OMB_TUNNEL_SOCKET?.trim() || null;',
      '    console.log(`openmausbot tunnel listener on ${TUNNEL_SOCKET}`);',
      '  });',
      '}',
      '      tunnelListener?.close(); stopCloudHomeConnectedApps();',
    ].join("\n");
    const patched = patchPrivateHost(sample);
    expect(patched).toContain('if (HOSTED_WORKSPACE || process.env.OMB_MATRIX_PAIR_SOCKET) setDefaultApprovalMode("ask");');
    expect(patched).toContain('req.method !== "POST" || req.url !== "/pairing"');
    expect(patched).toContain('chmodSync(pairSocket, 0o600)');
    expect(patched).toContain("matrixTimingSafeEqual(expectedProof, Buffer.from(presented[1]!))");
    expect(patched).toContain("process.stdin.destroy()");
    expect(patched).toContain('sessions.openPairing({ label: "Matrix Private Preview", ttlMs: 5 * 60_000 })');
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
    expect(bundle).toContain('"${HOST_BUNDLE_OPENMAUSBOT_PREVIEW:-false}" = "true"');
    expect(bundle).toContain('test "${HOST_BUNDLE_CHANNEL:-}" = none');
    expect(workflow).toContain("contains(github.event.pull_request.labels.*.name, 'openmausbot-preview')");
    expect(workflow).toContain('[ "$action" = "bundle" ] && [ "$has_openmausbot_label" = "true" ]');
    expect(workflow).toContain('HOST_BUNDLE_OPENMAUSBOT_PREVIEW: ${{ needs.gate.outputs.openmausbot_preview }}');
    expect(gatewayUnit).not.toContain("matrix-openmausbot.service");
    expect(bundle).toContain('unit.replace(wants, "$& matrix-openmausbot.service")');
    expect(unit).toContain("ConditionPathExists=/opt/matrix/bin/matrix-openmausbot.image-id");
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

  it("admits only the exact Platform owner-only preview host identity", async () => {
    const runtime = await readFile("scripts/openmausbot/matrix-openmausbot-run", "utf8");
    const admission = runtime.match(/^admit\(\) \{\n[\s\S]*?^\}/m)?.[0];
    expect(admission).toBeDefined();
    const temp = await mkdtemp(join(tmpdir(), "openmausbot-host-admission-"));
    try {
      const file = join(temp, "host.env");
      const base = [
        "MATRIX_PREVIEW_RUNTIME=true",
        "MATRIX_COLLABORATION_DISABLED=1",
        "MATRIX_HANDLE=pv-1907-3fa91c2e",
        "MATRIX_RUNTIME_SLOT=pv-1907-3fa91c2e",
        "PLATFORM_INTERNAL_URL=https://app.matrix-os.com",
        "MATRIX_UPDATE_MANIFEST_BASE_URL=https://app.matrix-os.com/private-preview-updates/pv-1907-3fa91c2e",
      ].join("\n");
      for (const [fixture, expected] of [
        [base, 0],
        [base.replace("MATRIX_COLLABORATION_DISABLED=1", "MATRIX_COLLABORATION_DISABLED=0"), 1],
        [base.replace("MATRIX_RUNTIME_SLOT=pv-1907-3fa91c2e", "MATRIX_RUNTIME_SLOT=primary"), 1],
        [base.replaceAll("pv-1907-3fa91c2e", "pr-1907"), 1],
        [base.replace("private-preview-updates/pv-1907-3fa91c2e", "private-preview-updates/pv-1907-3fa91c2f"), 1],
      ] as const) {
        await writeFile(file, `${fixture}\n`);
        const result = spawnSync("bash", ["-c", `env_file="$1"\n${admission}\nadmit`, "bash", file]);
        expect(result.status).toBe(expected);
      }
    } finally {
      await rm(temp, { force: true, recursive: true });
    }
  });
});
