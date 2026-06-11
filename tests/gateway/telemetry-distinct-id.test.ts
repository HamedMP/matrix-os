import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The gateway runs on a single-owner VPS, so product/terminal telemetry must
// be attributed to the owner (Clerk user id, falling back to the handle)
// instead of an anonymous service-level distinct id.
describe("gateway telemetry distinct id wiring", () => {
  const source = readFileSync(join(process.cwd(), "packages/gateway/src/server.ts"), "utf8");

  it("resolves the owner distinct id from the observability helper", () => {
    expect(source).toMatch(/resolveOwnerTelemetryDistinctId/);
  });

  it("stamps the owner distinct id on terminal websocket events", () => {
    const wrapper = extractFunction(source, "captureTerminalEvent");
    expect(wrapper).toMatch(/distinctId/);
  });

  it("stamps the owner distinct id on gateway product events", () => {
    const wrapper = extractFunction(source, "captureGatewayProductEvent");
    expect(wrapper).toMatch(/distinctId/);
  });

  it("does not attribute system update requests to the raw handle env only", () => {
    expect(source).not.toMatch(/distinctId:\s*process\.env\.MATRIX_HANDLE\s*\?\?\s*"matrix-gateway"/);
  });
});

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = (`);
  expect(start, `${name} must exist in server.ts`).toBeGreaterThanOrEqual(0);
  const openBrace = source.indexOf("{", source.indexOf("=>", start));
  expect(openBrace).toBeGreaterThan(start);

  let depth = 0;
  for (let i = openBrace; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Could not find end of ${name}`);
}
