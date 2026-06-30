import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const installUrl = "https://matrix-os.com/install-server.sh";
const privateServicePorts = ["3000", "4000", "8787", "8788", "5432"] as const;

describe("self-host public docs", () => {
  it("documents the main-domain server installer in docs and README", () => {
    const docs = readFileSync(join(root, "www/content/docs/self-host.mdx"), "utf8");
    const meta = readFileSync(join(root, "www/content/docs/meta.json"), "utf8");
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const quickstart = readFileSync(join(root, "www/content/docs/quickstart.mdx"), "utf8");

    expect(docs).toContain(installUrl);
    expect(docs).toContain("Matrix Cloud");
    expect(docs).toContain("Self-host preview");
    expect(docs).toContain("nginx Basic Auth");
    expect(docs).toContain("server IP address");
    expect(docs).toContain("No domain is required");
    expect(docs).toContain("Manual Install Telemetry");
    expect(docs).toContain("MATRIX_NO_TELEMETRY=1");
    expect(docs).toContain("does not send your Matrix handle");
    const publicPortWarning = docs.match(/^Do not expose ports `[^\n]+ publicly/m)?.[0] ?? "";
    expect(publicPortWarning).toContain("Do not expose ports");
    for (const port of privateServicePorts) {
      expect(publicPortWarning).toContain(`\`${port}\``);
    }
    expect(meta).toContain("\"self-host\"");
    expect(readme).toContain("### Managed Matrix Cloud");
    expect(readme).toContain("### Manual VPS Install");
    expect(readme).toContain(installUrl);
    expect(readme).toContain("A domain is optional");
    expect(readme).toContain("Self-host docs");
    expect(quickstart).toContain("Managed Matrix Cloud");
    expect(quickstart).toContain("Manual VPS install");
    expect(quickstart).toContain("A domain is optional for first boot");
  });

  it("adds self-host as a landing-page deployment option", () => {
    const page = readFileSync(join(root, "www/src/app/page.tsx"), "utf8");
    const deployment = readFileSync(join(root, "www/src/components/landing/DeploymentSection.tsx"), "utf8");

    expect(page).toContain("<DeploymentSection />");
    expect(deployment).toContain("Managed Matrix Cloud");
    expect(deployment).toContain("Manual VPS install");
    expect(deployment).toContain("Install from the main domain on your own Linux VPS");
    expect(deployment).toContain("href=\"/docs/self-host\"");
    expect(deployment).toContain("Choose managed or manual install.");
    expect(deployment).toContain("Start with Matrix Cloud, or bring your own Linux VPS.");
  });
});
