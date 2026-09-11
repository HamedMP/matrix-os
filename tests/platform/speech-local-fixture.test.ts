import { describe, expect, it } from "vitest";
import {
  assertFixturePortsAvailable,
  createLocalSpeechFixturePlan,
  parseLocalPostgresAdminUrl,
} from "../../scripts/lib/platform-speech-local-fixture.js";

describe("local speech fixture planning", () => {
  it("creates an isolated disposable database, runtime, home and credential set", () => {
    const randomValues = [
      "a".repeat(24),
      "b".repeat(64),
      "c".repeat(64),
      "d".repeat(64),
      "e".repeat(64),
    ];
    const plan = createLocalSpeechFixturePlan({
      adminUrl: "postgresql://fixture:local-only@127.0.0.1:5432/postgres",
      randomHex: () => randomValues.shift()!,
      temporaryRoot: "/tmp",
    });

    expect(plan.databaseName).toBe(`matrixos_speech_fixture_test_${"a".repeat(24)}`);
    expect(plan.databaseRole).toBe(`matrixos_speech_fixture_test_role_${"a".repeat(24)}`);
    expect(plan.databasePassword).toBe("b".repeat(64));
    expect(new URL(plan.databaseUrl).pathname).toBe(`/${plan.databaseName}`);
    expect(new URL(plan.databaseUrl).username).toBe(plan.databaseRole);
    expect(new URL(plan.databaseUrl).password).toBe(plan.databasePassword);
    expect(plan.ownerDatabaseName).toBe(`${plan.databaseName}_owner`);
    expect(new URL(plan.ownerDatabaseUrl).pathname).toBe(`/${plan.ownerDatabaseName}`);
    expect(plan.ownerDatabaseUrl).not.toBe(plan.databaseUrl);
    expect(plan.homePath).toBe(`/tmp/${plan.databaseName}-home`);
    expect(plan.env).toMatchObject({
      NODE_ENV: "development",
      PLATFORM_RUNTIME_MODE: "local",
      PLATFORM_DATABASE_URL: plan.databaseUrl,
      DATABASE_URL: plan.ownerDatabaseUrl,
      PLATFORM_PORT: "9117",
      MATRIX_SPEECH_GATEWAY_PORT: "4117",
      MATRIX_SPEECH_SHELL_PORT: "3117",
      PLATFORM_INTERNAL_URL: "http://127.0.0.1:9117",
      GATEWAY_URL: "http://127.0.0.1:4117",
      NEXT_PUBLIC_GATEWAY_WS: "ws://127.0.0.1:4117/ws",
      MATRIX_PLATFORM_SPEECH_ENABLED: "true",
      PLATFORM_SPEECH_ENABLED: "true",
      PLATFORM_SPEECH_PROVIDER: "fixture",
      PLATFORM_SPEECH_FIXTURE_TRANSCRIPT: "Deterministic local speech fixture transcript",
      PLATFORM_SPEECH_OPENAI_API_KEY: "",
      MATRIX_HOME: plan.homePath,
      E2E_TEST_BYPASS: "1",
      NEXT_PUBLIC_E2E_TEST_BYPASS: "1",
      NEXT_PUBLIC_E2E_AUTHENTICATE_WS: "1",
    });
    expect(plan.env.PLATFORM_SECRET).toHaveLength(64);
    expect(plan.env.PLATFORM_SPEECH_SECRET).toHaveLength(64);
    expect(plan.env.MATRIX_AUTH_TOKEN).toHaveLength(64);
    expect(new Set([
      plan.databasePassword,
      plan.env.PLATFORM_SECRET,
      plan.env.PLATFORM_SPEECH_SECRET,
      plan.env.MATRIX_AUTH_TOKEN,
    ])).toHaveLength(4);
    expect(plan.env.MATRIX_FUNDED_AI_RUNTIME_TOKEN).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects non-loopback PostgreSQL admin URLs before any connection", () => {
    expect(() => parseLocalPostgresAdminUrl("postgresql://fixture@db.example.com/postgres"))
      .toThrow("must use a loopback PostgreSQL host");
    expect(() => parseLocalPostgresAdminUrl("https://127.0.0.1/postgres"))
      .toThrow("must be a PostgreSQL URL");
  });

  it("rejects invalid fixture ports before attempting to bind", async () => {
    await expect(assertFixturePortsAvailable([1_023])).rejects.toThrow("must be unprivileged TCP ports");
  });
});
