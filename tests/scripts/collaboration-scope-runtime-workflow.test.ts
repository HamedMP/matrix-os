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

  it("targets only the exact disposable PR preview and authenticates every remote command", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("handle=pr-$PR");
    expect(workflow).toContain(".runtimeSlot == $handle");
    expect(workflow).toContain(".status == \"running\"");
    expect(workflow).toContain("x-matrix-acceptance-signature");
    expect(workflow).toContain("x-matrix-acceptance-response-signature");
    expect(workflow).toContain("--resolve \"app.matrix-os.com:443:${ADDRESS}\"");
  });

  it("uploads only the reviewed probe assets, sets the disposable marker, and retains evidence", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("scripts/spikes/collaboration/scope-runtime-probe.ts");
    expect(workflow).toContain("scripts/spikes/collaboration/scope-runtime-sdk-probe.mjs");
    expect(workflow).toContain("scripts/spikes/collaboration/scope-runtime-broker-fixture.mjs");
    expect(workflow).toContain("scripts/spikes/collaboration/native-isolation-acceptance.sh");
    expect(workflow).toContain("MATRIX_SCOPE_PROBE_DISPOSABLE=1");
    expect(workflow).toContain("scope-runtime-native-evidence-");
    expect(workflow).toContain("retention-days: 7");
  });
});
