import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const installUrl = "https://matrix-os.com/install-server.sh";

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
    expect(docs).toContain("Do not expose ports `3000`, `4000`, `8787`, or `5432` publicly");
    expect(meta).toContain("\"self-host\"");
    expect(readme).toContain("### Self-host on Your VPS");
    expect(readme).toContain(installUrl);
    expect(readme).toContain("A domain is optional");
    expect(readme).toContain("Self-host docs");
    expect(quickstart).toContain("[Self-host](/docs/self-host)");
  });

  it("adds self-host as a landing-page deployment option", () => {
    const page = readFileSync(join(root, "www/src/app/page.tsx"), "utf8");
    const deployment = readFileSync(join(root, "www/src/components/landing/DeploymentSection.tsx"), "utf8");

    expect(page).toContain("<DeploymentSection />");
    expect(deployment).toContain("Self-host Matrix");
    expect(deployment).toContain("Install from the main domain on your own Linux VPS");
    expect(deployment).toContain("href=\"/docs/self-host\"");
    expect(deployment).toContain("Hosted, self-hosted, or guided for organizations.");
  });
});
