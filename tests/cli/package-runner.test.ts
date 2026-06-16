import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  formatUnsupportedNodeError,
  isSupportedNodeVersion,
  nodeMajor,
} from "../../packages/sync-client/src/lib/node-runtime-guard.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../..");

describe("published CLI package runners", () => {
  it("keeps package metadata compatible with npx and pnpm dlx", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(repoRoot, "packages/sync-client/package.json"), "utf8"),
    );

    expect(packageJson.name).toBe("@finnaai/matrix");
    expect(packageJson.engines.node).toBe(">=20");
    expect(packageJson.dependencies).not.toHaveProperty("posthog-node");
    expect(packageJson.bin).toEqual({
      matrix: "bin/matrix.mjs",
      matrixos: "bin/matrix.mjs",
      mos: "bin/matrix.mjs",
    });
    expect(packageJson.files).toEqual(expect.arrayContaining(["bin/", "src/", "README.md"]));
    expect(packageJson.publishConfig).toMatchObject({
      access: "public",
      registry: "https://registry.npmjs.org/",
    });
  });

  it("reports Node runtime prerequisites before loading the TypeScript CLI", () => {
    expect(nodeMajor("20.14.1")).toBe(20);
    expect(isSupportedNodeVersion("20.0.0")).toBe(true);
    expect(formatUnsupportedNodeError("19.11.0", false)).toContain("Matrix CLI requires Node.js 20 or newer");
  });

  it("ships the standalone binary build helper used by the release workflow", async () => {
    const script = await readFile(
      resolve(repoRoot, "packages/sync-client/scripts/build-binaries.mjs"),
      "utf8",
    );

    expect(script).toContain('run("bun", [');
    expect(script).toContain('MATRIX_CLI_STANDALONE: "1"');
  });

  it("installs standalone binary upgrades atomically", async () => {
    const script = await readFile(resolve(repoRoot, "scripts/install.sh"), "utf8");

    expect(script).not.toContain('cp "$BIN_PATH" "$INSTALL_DIR/matrix"');
    expect(script).toContain('TMP_BIN="$INSTALL_DIR/.matrix.tmp.$$"');
    expect(script).toContain('mv -f "$TMP_BIN" "$INSTALL_DIR/matrix"');
    expect(script).toContain('sudo mv -f "$TMP_BIN" "$INSTALL_DIR/matrix"');
  });

  it("prefers upgrading the existing matrix command path before installing elsewhere", async () => {
    const script = await readFile(resolve(repoRoot, "scripts/install.sh"), "utf8");

    expect(script).toContain("existing_matrix_install_dir()");
    expect(script).toContain('EXISTING_MATRIX="$(command -v matrix 2>/dev/null || true)"');
    expect(script).toMatch(
      /elif EXISTING_DIR="\$\(existing_matrix_install_dir\)" && \[ -n "\$EXISTING_DIR" \]; then\n\s+INSTALL_DIR="\$EXISTING_DIR"\n\s+install_binary_unprivileged "\$INSTALL_DIR" \|\| install_binary_with_sudo "\$INSTALL_DIR"/,
    );
    expect(script).toContain('PATH_MATRIX="$(command -v matrix 2>/dev/null || true)"');
  });

  it("preserves the macOS package installer when available", async () => {
    const script = await readFile(resolve(repoRoot, "scripts/install.sh"), "utf8");
    const macosInstaller = script.slice(script.indexOf("install_macos() {"));
    const installDirBranch = macosInstaller.indexOf('if [ -n "${MATRIX_INSTALL_DIR:-}" ]; then');

    expect(script).toContain('PKG_NAME="MatrixSync-$VERSION.pkg"');
    expect(installDirBranch).toBeGreaterThan(-1);
    expect(installDirBranch).toBeLessThan(macosInstaller.indexOf('PKG_PATH="$INSTALL_TMPDIR/$PKG_NAME"'));
    expect(script).toContain('pkgutil --check-signature "$PKG_PATH"');
    expect(script).toContain('sudo installer -pkg "$PKG_PATH" -target /');
    expect(script).toMatch(
      /macOS package not available for \$TAG; installing CLI-only standalone binary"\n\s+rm -rf "\$INSTALL_TMPDIR"\n\s+install_cli_binary "darwin" "\$TAG"/,
    );
  });
});
