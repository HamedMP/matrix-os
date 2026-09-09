import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const workflowPath = ".github/workflows/collaboration-scope-runtime-acceptance.yml";

describe("collaboration scope-runtime production acceptance workflow", () => {
  it("runs only for an immutable same-repository PR head with both explicit labels", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("scope-runtime-production-acceptance");
    expect(workflow).toContain("preview-vps");
    expect(workflow).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(workflow).toContain("github.event.pull_request.head.sha");
    expect(workflow).toContain("ref: ${{ needs.gate.outputs.head }}");
  });

  it("targets only a stable disposable PR preview and authenticates every remote command", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("handle=pr-$PR");
    expect(workflow).toContain(".runtimeSlot == $handle");
    expect(workflow).toContain(".status == \"running\"");
    expect(workflow).toContain(".healthy == true");
    expect(workflow).toContain("stable_version");
    expect(workflow).toContain("stable_machine_id");
    expect(workflow).toContain("x-matrix-acceptance-signature");
    expect(workflow).toContain("x-matrix-acceptance-response-signature");
    expect(workflow).toContain("--resolve \"app.matrix-os.com:443:${ADDRESS}\"");
  });

  it("permits an older stable host bundle only when its installed SDK matches the immutable head", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("packages/kernel/package.json");
    expect(workflow).toContain("expected_sdk_version");
    expect(workflow).toContain("agent_sdk_version=${expected_sdk_version}");
    expect(workflow.indexOf(".exitCode == 0")).toBeLessThan(
      workflow.indexOf("agent_sdk_version=${expected_sdk_version}"),
    );
    expect(workflow).toContain("The disposable host bundle differs from the immutable probe head");
    expect(workflow).toContain("previewVersion: $version");
    expect(workflow).not.toContain("previewMachineId:");
  });

  it("uploads only the reviewed probe assets, sets the disposable marker, and retains evidence", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("scripts/spikes/collaboration/scope-runtime-probe.ts");
    expect(workflow).toContain("scripts/spikes/collaboration/scope-runtime-sdk-probe.mjs");
    expect(workflow).toContain("scripts/spikes/collaboration/scope-runtime-broker-fixture.mjs");
    expect(workflow).toContain("scripts/spikes/collaboration/native-isolation-acceptance.sh");
    expect(workflow).toContain("MATRIX_SCOPE_PROBE_DISPOSABLE=1");
    expect(workflow).toContain("ROOT_STAGING_DIR=/var/lib/matrix-scope-runtime/acceptance");
    expect(workflow).toContain("stage_root_asset");
    expect(workflow).toContain('"/usr/bin/install","--owner=root","--group=root"');
    expect(workflow).toContain('"/usr/bin/sha256sum","--"');
    expect(workflow).not.toContain('"/var/tmp/matrix-scope-native-acceptance.sh"],"timeoutMs"');
    expect(workflow).toContain("scope-runtime-native-evidence-");
    expect(workflow).toContain("retention-days: 7");
  });

  it("pins actions used by the privileged acceptance job to immutable commits", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain(
      "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6",
    );
    expect(workflow).toContain(
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7",
    );
    expect(workflow).not.toMatch(/uses: actions\/(?:checkout|upload-artifact)@v\d+/);
  });
});
