import { describe, it, expect, afterEach } from "vitest";
import { dirname } from "node:path";
import { safeEnv, safeBuildEnv } from "../../../packages/gateway/src/app-runtime/safe-env.js";

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

describe("safeBuildEnv", () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("strips explicit denylist entries (MATRIX_AUTH_TOKEN, DATABASE_URL, NODE_OPTIONS)", () => {
    process.env.MATRIX_AUTH_TOKEN = "hkdf-master-secret";
    process.env.DATABASE_URL = "postgres://secret@db/prod";
    process.env.NODE_OPTIONS = "--inspect=0.0.0.0:9229";
    const env = safeBuildEnv();
    expect(env.MATRIX_AUTH_TOKEN).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it("strips *_SECRET, *_TOKEN, *_API_KEY, *_PRIVATE_KEY, *_PASSWORD suffixes", () => {
    process.env.CLERK_SECRET_KEY = "sk_test_secret";
    process.env.CLAUDE_API_KEY = "sk-ant-secret";
    process.env.GITHUB_TOKEN = "ghp_secret";
    process.env.SSH_PRIVATE_KEY = "-----BEGIN-----";
    process.env.DB_PASSWORD = "pw";
    const env = safeBuildEnv();
    expect(env.CLERK_SECRET_KEY).toBeUndefined();
    expect(env.CLAUDE_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.SSH_PRIVATE_KEY).toBeUndefined();
    expect(env.DB_PASSWORD).toBeUndefined();
  });

  it("lets tooling env through (XDG_*, npm_config_*, TMPDIR, locale) so pnpm and vite work", () => {
    process.env.XDG_CONFIG_HOME = "/tmp/xdg-config";
    process.env.npm_config_registry = "https://registry.npmjs.org/";
    process.env.TMPDIR = "/tmp";
    process.env.LANG = "en_US.UTF-8";
    const env = safeBuildEnv();
    expect(env.XDG_CONFIG_HOME).toBe("/tmp/xdg-config");
    expect(env.npm_config_registry).toBe("https://registry.npmjs.org/");
    expect(env.TMPDIR).toBe("/tmp");
    expect(env.LANG).toBe("en_US.UTF-8");
  });

  it("does NOT strip public/publishable keys that legitimately end in _KEY", () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_public";
    process.env.MY_CONFIG_KEY = "not-a-secret";
    const env = safeBuildEnv();
    expect(env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY).toBe("pk_test_public");
    expect(env.MY_CONFIG_KEY).toBe("not-a-secret");
  });

  it("forces NODE_ENV=production even when gateway is in development", () => {
    process.env.NODE_ENV = "development";
    const env = safeBuildEnv();
    expect(env.NODE_ENV).toBe("production");
  });

  it("sets npm_config_store_dir when storeDir is given, leaves it unset otherwise", () => {
    delete process.env.npm_config_store_dir;
    expect(safeBuildEnv().npm_config_store_dir).toBeUndefined();
    expect(safeBuildEnv({ storeDir: "/var/pnpm-store" }).npm_config_store_dir).toBe("/var/pnpm-store");
  });
});
