import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("Docker code-server dependency downloads", () => {
  it("passes the read-only CI token through an ephemeral BuildKit secret", () => {
    const workflow = parse(readFileSync(".github/workflows/docker-test.yml", "utf8"));
    const job = workflow.jobs["docker-build"];
    expect(workflow.permissions.contents).toBe("read");
    const build = job.steps.find((step: { name?: string }) => step.name === "Build dev image");
    expect(build.with.secrets).toContain('github_token=${{ github.token }}');
    expect(build.with["build-args"] ?? "").not.toMatch(/GITHUB_TOKEN|github_token/);
    const dockerfile = readFileSync("Dockerfile.dev", "utf8");
    const builder = dockerfile.slice(0, dockerfile.indexOf("FROM node:24-alpine"));
    expect(builder).toContain("RUN --mount=type=secret,id=github_token,env=GITHUB_TOKEN");
    expect(builder).not.toMatch(/^(?:ARG|ENV)\s+GITHUB_TOKEN/m);
    expect(builder).toContain("npm install --unsafe-perm --foreground-scripts code-server@");
  });
});
