import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

// Keep source contracts together to avoid a worker/module setup per small suite.
describe("posthog-logship", () => {
  const repoRoot = process.cwd();

  function readRepoFile(path: string): string {
    return readFileSync(join(repoRoot, path), "utf8");
  }

  describe("PostHog fleet log shipping", () => {
    it("dual-writes Alloy journal and JSONL logs to Loki and PostHog OTLP", () => {
      const installer = readRepoFile("distro/customer-vps/host-bin/matrix-install-logship");

      expect(installer).toContain('POSTHOG_PROJECT_TOKEN="${POSTHOG_PROJECT_TOKEN:?POSTHOG_PROJECT_TOKEN must be set in the environment}"');
      expect(installer).toContain('otelcol.receiver.loki "posthog"');
      expect(installer).toContain('otelcol.exporter.otlphttp "posthog_logs"');
      expect(installer).toContain('logs_endpoint = "https://eu.i.posthog.com/i/v1/logs"');
      expect(installer).toContain('headers = { "Authorization" = "Bearer " + sys.env("POSTHOG_PROJECT_TOKEN") }');

      expect(installer).toContain('forward_to    = [loki.write.central.receiver, otelcol.receiver.loki.posthog.receiver]');
      expect(installer).toContain('path_targets = [{ __path__ = "${MATRIX_HOME_LOGS}/*.jsonl", source = "jsonl", handle = "${HANDLE}", env = "${MATRIX_ENV}" }]');
      expect(installer).not.toMatch(/loki\.source\.file "kernel_logs" \{[^}]*\n\s+labels\s+=/);
      expect(installer).toContain('forward_to = [loki.write.central.receiver, otelcol.receiver.loki.posthog.receiver]');
    });

    it("does not configure a journal source for the retired Symphony service", () => {
      const installer = readRepoFile("distro/customer-vps/host-bin/matrix-install-logship");
      expect(installer).not.toContain('loki.source.journal "matrix_symphony"');
    });

    it("threads the PostHog project token through logship enrollment without argv exposure", () => {
      const helper = readRepoFile("scripts/enable-vps-logship.sh");

      expect(helper).toContain(": \"${POSTHOG_PROJECT_TOKEN:?POSTHOG_PROJECT_TOKEN must be set}\"");
      expect(helper).toContain("printf '%s\\n%s\\n%s\\n' \"$LOGS_INGEST_USER\" \"$LOGS_INGEST_PASSWORD\" \"$POSTHOG_PROJECT_TOKEN\"");
      expect(helper).toContain("IFS= read -r t");
      expect(helper).toContain('POSTHOG_PROJECT_TOKEN=\\"\\$t\\"');
      expect(helper).toContain("/opt/matrix/bin/matrix-install-logship");
      expect(helper).not.toContain("/opt/matrix/app/bin/matrix-install-logship");
      expect(helper).not.toContain("POSTHOG_PROJECT_TOKEN='${POSTHOG_PROJECT_TOKEN}'");
    });
  });
});

describe("process-error-entrypoints", () => {
  describe("process-level PostHog error entrypoints", () => {
    it("wires gateway and platform process errors to their shared PostHog trackers", async () => {
      const [gatewayMain, platformMain, platformStartup] = await Promise.all([
        readFile("packages/gateway/src/main.ts", "utf8"),
        readFile("packages/platform/src/main.ts", "utf8"),
        readFile("packages/platform/src/platform-startup.ts", "utf8"),
      ]);

      expect(gatewayMain).toContain("installPostHogProcessErrorTracking");
      expect(gatewayMain).toContain('service: "matrix-gateway"');
      expect(gatewayMain).toContain("resolveOwnerTelemetryDistinctId");

      expect(platformMain).toContain("await startPlatformServer(");
      expect(platformStartup).toContain("installPostHogProcessErrorTracking");
      expect(platformStartup).toContain("service: 'matrix-platform'");
      expect(platformStartup).toContain("posthogProcessErrors.dispose()");
    });
  });
});

describe("cloudflared-ingress", () => {
  describe("cloudflared observability ingress", () => {
    it("does not expose Grafana through the public tunnel", async () => {
      const source = await readFile("distro/cloudflared.yml", "utf8");

      expect(source).not.toContain("grafana.matrix-os.com");
      expect(source).not.toMatch(/service:\s*http:\/\/grafana:3000/);
    });
  });
});

describe("promtail-client-errors", () => {
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
});
