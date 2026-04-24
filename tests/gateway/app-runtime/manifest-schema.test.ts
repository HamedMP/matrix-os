import { describe, it, expect } from "vitest";
import { AppManifestSchema, parseManifest, type AppManifest } from "../../../packages/gateway/src/app-runtime/manifest-schema.js";

describe("AppManifestSchema", () => {
  it("parses a valid static app manifest", () => {
    const input = {
      name: "Calculator",
      slug: "calculator",
      version: "1.0.0",
      runtime: "static",
      runtimeVersion: "^1.0.0",
    };
    const result = AppManifestSchema.parse(input);
    expect(result.runtime).toBe("static");
    expect(result.scope).toBe("personal");
  });

  it("parses a valid vite app manifest with build section", () => {
    const input = {
      name: "Notes",
      slug: "notes",
      version: "2.0.0",
      runtime: "vite",
      runtimeVersion: "^1.0.0",
      build: {
        install: "pnpm install --frozen-lockfile",
        command: "pnpm build",
        output: "dist",
        timeout: 120,
      },
    };
    const result = AppManifestSchema.parse(input);
    expect(result.runtime).toBe("vite");
    expect(result.build?.timeout).toBe(120);
  });

  it("parses a valid node app manifest with serve section", () => {
    const input = {
      name: "Mail",
      slug: "mail",
      version: "1.0.0",
      runtime: "node",
      runtimeVersion: "^1.0.0",
      build: { command: "pnpm build", output: ".next" },
      serve: {
        start: "pnpm start",
        healthCheck: "/api/health",
        startTimeout: 10,
        idleShutdown: 300,
      },
    };
    const result = AppManifestSchema.parse(input);
    expect(result.serve?.healthCheck).toBe("/api/health");
  });

  it("rejects authored distributionStatus field", () => {
    const input = {
      name: "Evil",
      slug: "evil",
      version: "1.0.0",
      runtime: "static",
      runtimeVersion: "^1.0.0",
      distributionStatus: "installable",
    };
    expect(() => AppManifestSchema.parse(input)).toThrow();
  });

  it("validates runtime enum (rejects unknown runtimes)", () => {
    const input = {
      name: "X",
      slug: "x",
      version: "1.0.0",
      runtime: "deno",
      runtimeVersion: "^1.0.0",
    };
    expect(() => AppManifestSchema.parse(input)).toThrow();
  });

  it("rejects invalid semver runtimeVersion", () => {
    const input = {
      name: "X",
      slug: "x",
      version: "1.0.0",
      runtime: "static",
      runtimeVersion: "not-a-semver",
    };
    expect(() => AppManifestSchema.parse(input)).toThrow();
  });

  it("scope defaults to personal", () => {
    const input = {
      name: "X",
      slug: "x",
      version: "1.0.0",
      runtime: "static",
      runtimeVersion: "^1.0.0",
    };
    const result = AppManifestSchema.parse(input);
    expect(result.scope).toBe("personal");
  });

  it("rejects vite manifest without build section", () => {
    const input = {
      name: "X",
      slug: "x",
      version: "1.0.0",
      runtime: "vite",
      runtimeVersion: "^1.0.0",
    };
    expect(() => AppManifestSchema.parse(input)).toThrow();
  });

  it("rejects node manifest without serve section", () => {
    const input = {
      name: "X",
      slug: "x",
      version: "1.0.0",
      runtime: "node",
      runtimeVersion: "^1.0.0",
      build: { command: "pnpm build", output: "dist" },
    };
    expect(() => AppManifestSchema.parse(input)).toThrow();
  });

  it("applies default resource limits when omitted", () => {
    const input = {
      name: "X",
      slug: "x",
      version: "1.0.0",
      runtime: "static",
      runtimeVersion: "^1.0.0",
    };
    const result = AppManifestSchema.parse(input);
    expect(result.resources).toEqual({
      memoryMb: 256,
      cpuShares: 512,
      maxFileHandles: 128,
    });
  });

  it("rejects slug with path traversal characters", () => {
    const input = {
      name: "X",
      slug: "../../etc/passwd",
      version: "1.0.0",
      runtime: "static",
      runtimeVersion: "^1.0.0",
    };
    expect(() => AppManifestSchema.parse(input)).toThrow();
  });

  it("rejects slug starting with a hyphen", () => {
    const input = {
      name: "X",
      slug: "-bad",
      version: "1.0.0",
      runtime: "static",
      runtimeVersion: "^1.0.0",
    };
    expect(() => AppManifestSchema.parse(input)).toThrow();
  });

  it("accepts optional dev flag as advisory boolean", () => {
    const input = {
      name: "DevApp",
      slug: "dev-app",
      version: "0.1.0",
      runtime: "vite",
      runtimeVersion: "^1.0.0",
      build: { command: "pnpm build", output: "dist" },
      dev: true,
    };
    const result = AppManifestSchema.parse(input);
    expect(result.dev).toBe(true);
  });

  it("parseManifest wraps Zod errors in typed ManifestError", async () => {
    const result = await parseManifest({ name: "X" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_manifest");
    }
  });
});
