import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "chess-app-test-mock",
      enforce: "pre",
      resolveId(source, importer) {
        if (!importer) return null;
        const normalized = importer.split(path.sep).join("/");
        if (
          source === "@tiptap/react" &&
          normalized.endsWith("/home/apps/notes/src/RichEditor.tsx")
        ) {
          return path.resolve(__dirname, "tests/default-apps/mocks/tiptap-react.ts");
        }
        if (
          source === "@tiptap/starter-kit" &&
          normalized.endsWith("/home/apps/notes/src/RichEditor.tsx")
        ) {
          return path.resolve(__dirname, "tests/default-apps/mocks/tiptap-starter-kit.ts");
        }
        if (source !== "chess.js") return null;
        // Keep FakeChess scoped to the chess app integration test and the
        // component it renders so lower-level chess unit tests opt in explicitly.
        if (
          normalized.endsWith("/tests/default-apps/chess-app.test.tsx") ||
          normalized.endsWith("/home/apps/games/chess/src/App.tsx")
        ) {
          return path.resolve(__dirname, "tests/default-apps/mocks/chess-js.ts");
        }
        return null;
      },
    },
  ],
  resolve: {
    conditions: ["node"],
    alias: {
      "@": path.resolve(__dirname, "shell/src"),
      "@desktop": path.resolve(__dirname, "desktop/src"),
      "@renderer": path.resolve(__dirname, "desktop/src/renderer/src"),
      "@matrix-os/brand": path.resolve(__dirname, "packages/brand/src/index.ts"),
      "@matrix-os/contracts": path.resolve(__dirname, "packages/contracts/src/index.ts"),
      "@matrix-os/observability/client": path.resolve(
        __dirname,
        "packages/observability/src/client.ts",
      ),
      "@matrix-os/observability/events": path.resolve(
        __dirname,
        "packages/observability/src/events.ts",
      ),
      "@matrix-os/kernel/security/external-content": path.resolve(
        __dirname,
        "packages/kernel/src/security/external-content.ts",
      ),
      "@matrix-os/kernel/security/audit": path.resolve(
        __dirname,
        "packages/kernel/src/security/audit.ts",
      ),
      "@matrix-os/kernel/security/ssrf-guard": path.resolve(
        __dirname,
        "packages/kernel/src/security/ssrf-guard.ts",
      ),
      "@matrix-os/kernel/skill-registry": path.resolve(
        __dirname,
        "packages/kernel/src/skill-registry.ts",
      ),
      "@matrix-os/kernel": path.resolve(__dirname, "packages/kernel/src/index.ts"),
      react: path.resolve(__dirname, "node_modules/react"),
      "react-dom": path.resolve(__dirname, "node_modules/react-dom"),
      "@aws-sdk/client-s3": path.resolve(__dirname, "node_modules/@aws-sdk/client-s3"),
    },
  },
  test: {
    globals: true,
    // CI runners are sometimes slow under load; tests that rely on async
    // waitFor polling can exceed the 5s vitest default.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // PGlite-backed suites are memory- and CPU-heavy during database startup.
    // Keep file-level parallelism bounded so full-suite runs do not starve
    // KyselyPGlite.create() hooks under shared CI or agent-machine load.
    maxWorkers: 2,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: ["tests/**/*.integration.ts", "node_modules", "dist", ".next"],
    coverage: {
      provider: "v8",
      include: [
        "packages/kernel/src/**",
        "packages/gateway/src/**",
        "packages/platform/src/**",
        "desktop/src/renderer/src/**",
      ],
      exclude: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/*.integration.ts",
        "desktop/src/renderer/src/main.tsx",
      ],
      thresholds: {
        statements: 99,
        branches: 95,
        functions: 99,
        lines: 99,
      },
    },
  },
});
