import { describe, it, expect, afterEach } from "vitest";
import { dirname } from "node:path";
import { safeEnv } from "../../../packages/gateway/src/app-runtime/safe-env.js";

describe("safeEnv", () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("sets PORT to the given port as a string", () => {
    const env = safeEnv({ slug: "notes", port: 40123, homeDir: "/tmp/home" });
    expect(env.PORT).toBe("40123");
  });

  it("sets NODE_ENV to production", () => {
    const env = safeEnv({ slug: "notes", port: 40000, homeDir: "/tmp/home" });
    expect(env.NODE_ENV).toBe("production");
  });

  it("sets MATRIX_APP_SLUG to the given slug", () => {
    const env = safeEnv({ slug: "my-app", port: 40000, homeDir: "/tmp/home" });
    expect(env.MATRIX_APP_SLUG).toBe("my-app");
  });

  it("sets MATRIX_APP_DATA_DIR relative to homeDir", () => {
    const env = safeEnv({ slug: "notes", port: 40000, homeDir: "/tmp/home" });
    expect(env.MATRIX_APP_DATA_DIR).toMatch(/data\/notes$/);
  });

  it("sets MATRIX_GATEWAY_URL to localhost:4000", () => {
    const env = safeEnv({ slug: "notes", port: 40000, homeDir: "/tmp/home" });
    expect(env.MATRIX_GATEWAY_URL).toBe("http://127.0.0.1:4000");
  });

  it("strips CLAUDE_API_KEY from the environment", () => {
    process.env.CLAUDE_API_KEY = "sk-ant-secret";
    const env = safeEnv({ slug: "notes", port: 40000, homeDir: "/tmp/home" });
    expect(env.CLAUDE_API_KEY).toBeUndefined();
  });

  it("strips CLERK_SECRET_KEY from the environment", () => {
    process.env.CLERK_SECRET_KEY = "sk_test_secret";
    const env = safeEnv({ slug: "notes", port: 40000, homeDir: "/tmp/home" });
    expect(env.CLERK_SECRET_KEY).toBeUndefined();
  });

  it("strips NODE_OPTIONS to prevent debugger injection", () => {
    process.env.NODE_OPTIONS = "--inspect=0.0.0.0:9229";
    const env = safeEnv({ slug: "notes", port: 40000, homeDir: "/tmp/home" });
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it("strips DATABASE_URL", () => {
    process.env.DATABASE_URL = "postgres://secret@db/prod";
    const env = safeEnv({ slug: "notes", port: 40000, homeDir: "/tmp/home" });
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("strips ANTHROPIC_API_KEY", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-another";
    const env = safeEnv({ slug: "notes", port: 40000, homeDir: "/tmp/home" });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("provides a minimal PATH with system dirs and node binary", () => {
    process.env.PATH = "/usr/local/bin:/usr/bin:/bin:/home/user/.local/bin";
    const env = safeEnv({ slug: "notes", port: 40000, homeDir: "/tmp/home" });
    expect(env.PATH).toBeDefined();
    expect(env.PATH).toContain("/usr/bin");
    // Node binary dir is included so child processes can find `node`
    expect(env.PATH).toContain(dirname(process.execPath));
  });

  it("does not inherit arbitrary env vars from the gateway process", () => {
    process.env.MY_SECRET_SERVICE = "should-not-leak";
    process.env.RANDOM_VAR = "should-not-leak";
    const env = safeEnv({ slug: "notes", port: 40000, homeDir: "/tmp/home" });
    expect(env.MY_SECRET_SERVICE).toBeUndefined();
    expect(env.RANDOM_VAR).toBeUndefined();
  });

  it("sets HOME to the app directory", () => {
    const env = safeEnv({ slug: "notes", port: 40000, homeDir: "/tmp/home" });
    expect(env.HOME).toMatch(/apps\/notes$/);
  });

  it("includes only the expected keys (whitelist approach)", () => {
    const env = safeEnv({ slug: "x", port: 40000, homeDir: "/tmp/home" });
    const keys = Object.keys(env);
    const expectedKeys = [
      "PORT",
      "NODE_ENV",
      "HOME",
      "PATH",
      "MATRIX_APP_SLUG",
      "MATRIX_APP_DATA_DIR",
      "MATRIX_GATEWAY_URL",
    ];
    for (const k of expectedKeys) {
      expect(keys).toContain(k);
    }
    // No extra keys beyond the whitelist
    for (const k of keys) {
      expect(expectedKeys).toContain(k);
    }
  });
});
