import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
