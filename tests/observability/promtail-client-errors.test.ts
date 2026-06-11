import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Shell client errors land in ~/system/logs/client-errors.jsonl via the
// gateway's /api/client-errors route. The observability stack must ship that
// file into Loki under its own job so dashboards and alerts can query it
// separately from interaction logs.
describe("promtail client error shipping", () => {
  const promtail = readFileSync(
    join(process.cwd(), "distro/observability/promtail.yml"),
    "utf8",
  );

  it("scrapes the client error JSONL under a dedicated job", () => {
    expect(promtail).toContain("job_name: matrixos-client-errors");
    expect(promtail).toContain("job: matrixos-client-errors");
    expect(promtail).toContain(
      "__path__: /var/log/matrixos/system/logs/client-errors.jsonl",
    );
  });

  it("excludes client errors from the generic interaction-log job to avoid double-scraping", () => {
    expect(promtail).toContain(
      "__path_exclude__: /var/log/matrixos/system/logs/client-errors.jsonl",
    );
  });

  it("parses the JSONL timestamp and source like the interaction job", () => {
    const clientErrorsJob = promtail.slice(promtail.indexOf("job_name: matrixos-client-errors"));
    const jobBlock = clientErrorsJob.slice(
      0,
      clientErrorsJob.indexOf("- job_name:", 1) === -1
        ? undefined
        : clientErrorsJob.indexOf("- job_name:", 1),
    );
    expect(jobBlock).toContain("pipeline_stages:");
    expect(jobBlock).toContain("format: RFC3339");
  });
});
