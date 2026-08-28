import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("desktop release workflows", () => {
  it("verifies the mounted DMG background through Finder at its native volume path", () => {
    const workflow = readFileSync(join(root, ".github/workflows/desktop-build.yml"), "utf8");

    expect(workflow).toContain('attach_output="$(hdiutil attach "$dmg_path" -nobrowse -readonly)"');
    expect(workflow).toContain("/^\\/Volumes\\//");
    expect(workflow).not.toContain('-mountpoint "$mount_dir"');
    expect(workflow).toContain('open "$mount_dir"');
    expect(workflow).toContain("background picture of icon view options");
    expect(workflow).toContain('background_picture="missing value"');
    expect(workflow).toContain('"$mount_dir"/.background/*');
    expect(workflow).toContain('[ ! -f "$background_picture" ]');
    expect(workflow).toContain("close container window of disk volumeName");
    expect(workflow).toContain('hdiutil detach "$mount_dir" -quiet || true');
  });

  it("verifies packaged artifacts before renaming mac update manifests", () => {
    const workflow = readFileSync(join(root, ".github/workflows/desktop-build.yml"), "utf8");

    expect(workflow).toContain("Rename mac update manifest for arch");
    expect(workflow).toContain("Resolve mac artifact metadata");
    expect(workflow).toContain('package_version="$(node -p "require(\'./desktop/package.json\').version")"');
    expect(workflow).toContain('echo "artifact_base=Matrix-OS-${package_version}-mac-${{ matrix.arch }}"');
    expect(workflow).toContain("ARTIFACT_BASE: ${{ steps.mac_artifact.outputs.artifact_base }}");
    expect(workflow).toContain("[ ! -f desktop/dist/latest-mac.yml ]");
    expect(workflow).toContain('[ ! -f "desktop/dist/${ARTIFACT_BASE}.dmg" ]');
    expect(workflow).toContain('[ ! -f "desktop/dist/${ARTIFACT_BASE}.zip" ]');
    expect(workflow).toContain('[ ! -f "desktop/dist/${ARTIFACT_BASE}.dmg.blockmap" ]');
    expect(workflow).toContain('[ ! -f "desktop/dist/${ARTIFACT_BASE}.zip.blockmap" ]');
    expect(workflow).toContain('unexpected_artifact="$(');
    expect(workflow).toContain('-name "Matrix-OS-*-mac-*.dmg"');
    expect(workflow).toContain('! -name "${ARTIFACT_BASE}.zip.blockmap"');
    expect(workflow).not.toContain('other_arch="x64"');
    expect(workflow).toContain('find desktop/dist -path "*/Matrix OS.app/Contents/Resources/app-update.yml"');
    expect(workflow).toContain("Smoke test macOS DMG mount");
    expect(workflow).toContain("desktop-update-fixture-server.mjs");
    expect(workflow).toContain('OPERATOR_UPDATE_FEED="http://127.0.0.1:${update_port}/"');
    expect(workflow).toContain("runs-on: ${{ matrix.runner }}");
    expect(workflow).toMatch(
      /include:\n\s+- arch: arm64\n\s+runner: macos-latest\n\s+- arch: x64\n\s+runner: macos-15-intel/,
    );
    expect(workflow).toMatch(
      /launch_attempts=20\n\s+for \(\(attempt = 1; attempt <= launch_attempts; attempt \+= 1\)\); do/,
    );
    expect(workflow).not.toContain("starts through Rosetta");
    expect(workflow).toContain('grep -Fq "[updates] update check completed: up to date" "$app_log"');
    expect(workflow).toContain('grep -Fq "[updates] check failed:" "$app_log"');
    expect(workflow).toContain('attach_output="$(hdiutil attach "$dmg_path" -nobrowse -readonly)"');
    expect(workflow).toContain('[ ! -L "$mount_dir/Applications" ]');
    expect(workflow).toContain('applications_target="$(readlink "$mount_dir/Applications")"');
    expect(workflow).toContain('[ "$applications_target" != "/Applications" ]');
    expect(workflow).toContain('ditto "$mount_dir/Matrix OS.app" "$copy_dir/Matrix OS.app"');
    expect(workflow).toContain('find desktop/dist -maxdepth 1 -type f -name "*.AppImage" -print -quit');
    expect(workflow).toContain("[ ! -f desktop/dist/latest-linux.yml ]");
    expect(workflow).not.toContain("test -f desktop/dist/*.dmg");
    expect(workflow).not.toContain("test -f desktop/dist/*.zip");
    expect(workflow).not.toContain("test -f desktop/dist/*.AppImage");
    expect(workflow).not.toContain("test -f desktop/dist/*-mac.yml");
    expect(workflow).toContain('mv desktop/dist/latest-mac.yml "desktop/dist/${{ matrix.arch }}-mac.yml"');
    expect(workflow).toContain('mv "desktop/dist/${CHANNEL}-mac.yml" "desktop/dist/${{ matrix.arch }}-${CHANNEL}-mac.yml"');
    expect(workflow).toContain('! -name "${{ matrix.arch }}-mac.yml"');
    expect(workflow).toContain('! -name "${{ matrix.arch }}-${CHANNEL}-mac.yml"');
    expect(workflow).toContain("desktop/dist/*-mac.yml");
    expect(workflow).toContain("desktop/dist/*.blockmap");
  });

  it("lets the mac matrix arch control electron-builder outputs", () => {
    const config = readFileSync(join(root, "desktop/electron-builder.yml"), "utf8");

    expect(config).toContain("- dmg");
    expect(config).toContain("- zip");
    expect(config).not.toContain("arch: [arm64, x64]");
  });

  it("falls back from an empty desktop update channel at build time", () => {
    const config = readFileSync(join(root, "desktop/electron.vite.config.ts"), "utf8");

    expect(config).toContain(
      "process.env.MATRIX_DESKTOP_UPDATE_CHANNEL || process.env.OPERATOR_UPDATE_CHANNEL || \"\"",
    );
    expect(config).not.toContain("MATRIX_DESKTOP_UPDATE_CHANNEL ?? process.env.OPERATOR_UPDATE_CHANNEL");
  });

  it("injects the public PostHog support configuration into every packaged Desktop build", () => {
    const workflow = readFileSync(join(root, ".github/workflows/desktop-build.yml"), "utf8");

    expect(workflow.match(/VITE_POSTHOG_PROJECT_TOKEN:/g)).toHaveLength(2);
    expect(workflow.match(/VITE_POSTHOG_HOST:/g)).toHaveLength(2);
    expect(workflow).toContain("vars.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN || vars.NEXT_PUBLIC_POSTHOG_KEY");
    expect(workflow).toContain("vars.NEXT_PUBLIC_POSTHOG_HOST || 'https://eu.posthog.com'");
  });

  it("keeps raw workspace TypeScript out of the packaged app archive", () => {
    const builder = readFileSync(join(root, "desktop/electron-builder.yml"), "utf8");

    expect(builder).toContain('- "!**/node_modules/@matrix-os/contracts/**"');
  });

  it("bundles runtime schema dependencies into the Electron main process", () => {
    const config = readFileSync(join(root, "desktop/electron.vite.config.ts"), "utf8");
    const bundledContracts = config.match(
      /externalizeDepsPlugin\(\{ exclude: \["zod", "@matrix-os\/contracts"\] \}\)/g,
    );

    expect(bundledContracts).toHaveLength(2);
  });

  it("emits one self-contained sandbox preload for the shell and native apps", () => {
    const config = readFileSync(join(root, "desktop/electron.vite.config.ts"), "utf8");
    const preload = readFileSync(join(root, "desktop/src/preload/index.ts"), "utf8");
    const main = readFileSync(join(root, "desktop/src/main/index.ts"), "utf8");

    expect(config).toContain('input: resolve(__dirname, "src/preload/index.ts")');
    expect(config).toContain("inlineDynamicImports: true");
    expect(config).not.toContain('"app-bridge": resolve(');
    expect(preload).toContain('const NATIVE_APP_BRIDGE_ARG = "--matrix-app-bridge"');
    expect(preload).toContain("process.argv.includes(NATIVE_APP_BRIDGE_ARG)");
    expect(preload).toContain('contextBridge.exposeInMainWorld("MatrixOS"');
    expect(main).toContain('appPreloadPath: join(__dirname, "../preload/index.cjs")');
  });

  it("records the full canary app version in the release manifest", () => {
    const workflow = readFileSync(join(root, ".github/workflows/desktop-release-canary.yml"), "utf8");

    expect(workflow).toContain("version: ${{ steps.meta.outputs.version }}");
    expect(workflow).toContain("version: ${{ needs.prepare.outputs.version }}");
    expect(workflow).toContain("BASE_VERSION=");
    expect(workflow).toContain('echo "version=$BASE_VERSION-$SUFFIX" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain('${{ needs.prepare.outputs.version }}" canary "$GITHUB_SHA"');
    expect(workflow).not.toContain('${{ needs.prepare.outputs.suffix }}" canary "$GITHUB_SHA"');
    expect(workflow).not.toContain("version_suffix:");
  });

  it("publishes an immutable canary before advancing the channel pointer", () => {
    const workflow = readFileSync(join(root, ".github/workflows/desktop-release-canary.yml"), "utf8");
    const downloadIndex = workflow.indexOf("uses: actions/download-artifact@v6");
    const notesIndex = workflow.indexOf("name: Generate Desktop release notes");
    const channelManifestIndex = workflow.indexOf("name: Prepare channel pointer manifests");
    const immutablePublishIndex = workflow.indexOf("name: Publish immutable canary release");
    const channelTagIndex = workflow.indexOf("name: Advance desktop-canary tag");
    const channelPublishIndex = workflow.indexOf("name: Publish desktop-canary channel pointer");

    expect(workflow).toContain("GH_TOKEN: ${{ github.token }}");
    expect(workflow).toContain('IMMUTABLE_TAG="desktop-v${{ needs.prepare.outputs.version }}"');
    expect(workflow).toContain("previous_tag_name=desktop-canary");
    expect(workflow).toContain("scripts/release/prepare-desktop-channel-manifests.mjs");
    expect(workflow).toContain("tag_name: desktop-v${{ needs.prepare.outputs.version }}");
    expect(workflow).toContain("uses: ./.github/actions/guard-immutable-desktop-release");
    expect(workflow).toContain("overwrite_files: false");
    expect(workflow).toContain("tag_name: desktop-canary");
    expect(workflow).toContain("files: desktop-channel/**");
    expect(workflow).toContain("uses: ./.github/actions/prune-desktop-channel-assets");
    expect(workflow).not.toContain("gh release delete desktop-canary");
    expect(downloadIndex).toBeGreaterThan(-1);
    expect(notesIndex).toBeGreaterThan(downloadIndex);
    expect(channelManifestIndex).toBeGreaterThan(notesIndex);
    expect(immutablePublishIndex).toBeGreaterThan(channelManifestIndex);
    expect(channelTagIndex).toBeGreaterThan(immutablePublishIndex);
    expect(channelPublishIndex).toBeGreaterThan(channelTagIndex);
  });

  it("advances a channel pointer without taking over the repository-wide Latest release", () => {
    const workflow = readFileSync(join(root, ".github/workflows/desktop-release.yml"), "utf8");

    expect(workflow).toContain("group: desktop-release-${{ inputs.channel || 'stable' }}");
    expect(workflow).toContain('CHANNEL_TAG="desktop-$CHANNEL"');
    expect(workflow).toContain('previous_tag_name="$CHANNEL_TAG"');
    expect(workflow).toContain("scripts/release/prepare-desktop-channel-manifests.mjs");
    expect(workflow).toContain("name: Advance Desktop channel tag");
    expect(workflow).toContain("name: Publish Desktop channel pointer");
    expect(workflow).toContain("files: desktop-channel/**");
    expect(workflow).toContain("uses: ./.github/actions/guard-immutable-desktop-release");
    expect(workflow).toContain("uses: ./.github/actions/prune-desktop-channel-assets");
    expect(workflow).toContain("make_latest: false");
    expect(workflow).not.toContain("make_latest: ${{ needs.prepare.outputs.channel == 'stable' }}");
  });

  it("patches exact release versions and validates notarization inputs before packaging", () => {
    const build = readFileSync(join(root, ".github/workflows/desktop-build.yml"), "utf8");
    const release = readFileSync(join(root, ".github/workflows/desktop-release.yml"), "utf8");
    const canary = readFileSync(join(root, ".github/workflows/desktop-release-canary.yml"), "utf8");

    expect(build).toContain("Validate Apple notarization secrets");
    expect(build).toContain("Prepare mac signing environment");
    expect(build).toContain("MATRIX_DESKTOP_MAC_CERTIFICATE or CSC_LINK is required");
    expect(build).toContain("MATRIX_DESKTOP_MAC_CERTIFICATE_PASSWORD or CSC_KEY_PASSWORD is required");
    expect(build).not.toContain("CSC_IDENTITY_AUTO_DISCOVERY=false");
    expect(build).toContain("cert_delimiter=\"MATRIX_DESKTOP_CERT_$(uuidgen");
    expect(build).toContain("password_delimiter=\"MATRIX_DESKTOP_CERT_PASSWORD_$(uuidgen");
    expect(build).toContain("MAC_CERTIFICATE: ${{ secrets.MATRIX_DESKTOP_MAC_CERTIFICATE || secrets.CSC_LINK }}");
    expect(build).not.toContain("CSC_LINK: ${{ secrets.MATRIX_DESKTOP_MAC_CERTIFICATE || secrets.CSC_LINK }}");
    expect(build).toContain("Missing required Apple notarization secret");
    expect(build).toContain("Verify macOS signature and notarization");
    expect(build).toContain('codesign --verify --deep --strict --verbose=2 "$app_path"');
    expect(build).toContain('grep "Authority=Developer ID Application" >/dev/null');
    expect(build).toContain('xcrun stapler validate "$app_path"');
    expect(build).toContain('spctl --assess --type execute --verbose=4 "$app_path"');
    expect(build).toContain("Launch smoke test macOS app");
    expect(build).toContain("ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING");
    expect(build).toContain("Apply desktop release version");
    expect(build).toContain("RELEASE_VERSION: ${{ inputs.version }}");
    expect(build).toContain("j.version = exact ||");
    expect(release).toContain("version: ${{ needs.prepare.outputs.version }}");
    const immutableRelease = release.slice(
      release.indexOf("name: Create immutable GitHub release"),
      release.indexOf("name: Advance Desktop channel tag"),
    );
    expect(immutableRelease).toContain("overwrite_files: false");
    expect(immutableRelease).not.toContain("overwrite_files: true");
    expect(release).toContain("Merge channel macOS update manifests");
    expect(release).toContain("output: ${{ needs.prepare.outputs.channel }}-mac.yml");
    expect(canary).toContain("Merge canary macOS update manifests");
    expect(canary).toContain("output: canary-mac.yml");
    const immutableCanary = canary.slice(
      canary.indexOf("name: Publish immutable canary release"),
      canary.indexOf("name: Advance desktop-canary tag"),
    );
    expect(immutableCanary).toContain("overwrite_files: false");
    expect(immutableCanary).not.toContain("overwrite_files: true");
  });

  it("fails closed before replacing an existing immutable Desktop release", () => {
    const action = readFileSync(
      join(root, ".github/actions/guard-immutable-desktop-release/action.yml"),
      "utf8",
    );

    expect(action).toContain("releases/tags/${TAG_NAME}");
    expect(action).toContain("already exists and cannot be overwritten");
    expect(action).toContain("HTTP 404");
    expect(action).toContain('refs/tags/$TAG_NAME^{}');
    expect(action).toContain('REMOTE_TAG_SHA" != "$EXPECTED_SHA"');
  });

  it("keeps only the two platform manifests on a Desktop channel pointer release", () => {
    const action = readFileSync(
      join(root, ".github/actions/prune-desktop-channel-assets/action.yml"),
      "utf8",
    );

    expect(action).toContain('ALLOWED_MAC="latest-mac.yml"');
    expect(action).toContain('ALLOWED_LINUX="latest-linux.yml"');
    expect(action).toContain('ALLOWED_MAC="${CHANNEL}-mac.yml"');
    expect(action).toContain('ALLOWED_LINUX="${CHANNEL}-linux.yml"');
    expect(action).toContain('gh release delete-asset "$TAG_NAME" "$asset"');
    expect(action).toContain("--yes");
  });

  it("supports a dev desktop update channel for test releases", () => {
    const release = readFileSync(join(root, ".github/workflows/desktop-release.yml"), "utf8");

    expect(release).toContain("- dev");
    expect(release).toContain("stable|beta|canary|dev");
    expect(release).toContain("Non-stable desktop channels require a prerelease semver version.");
  });

  it("publishes a Linux manifest for every prerelease channel", () => {
    const build = readFileSync(join(root, ".github/workflows/desktop-build.yml"), "utf8");

    expect(build).toContain("Create Linux channel update manifest");
    expect(build).toContain('if [ "$CHANNEL" != "stable" ]; then');
    expect(build).toContain('cp desktop/dist/latest-linux.yml "desktop/dist/${CHANNEL}-linux.yml"');
    expect(build).toContain("desktop/dist/*-linux.yml");
  });

  it("rejects prerelease desktop tags on the push release path", () => {
    const release = readFileSync(join(root, ".github/workflows/desktop-release.yml"), "utf8");

    expect(release).toContain('if [ "$EVENT_NAME" = "push" ] && [[ "$VERSION" == *-* ]]; then');
    expect(release).toContain("Prerelease desktop versions must be released with workflow_dispatch");
  });

  it("rejects stable semver versions on prerelease desktop channels", () => {
    const release = readFileSync(join(root, ".github/workflows/desktop-release.yml"), "utf8");

    expect(release).toContain('if [ "$CHANNEL" != "stable" ] && [[ "$VERSION" != *-* ]]; then');
    expect(release).toContain("Non-stable desktop channels require a prerelease semver version.");
  });

  it("merges mac manifests in deterministic filename order", () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-desktop-release-"));
    try {
      writeFileSync(
        join(dir, "x64-mac.yml"),
        "version: 1.2.3\nfiles:\n  - url: x64.zip\n    sha512: x64\n    size: 2\npath: x64.zip\nsha512: x64\n",
      );
      writeFileSync(
        join(dir, "arm64-mac.yml"),
        "version: 1.2.3\nfiles:\n  - url: arm64.zip\n    sha512: arm64\n    size: 1\npath: arm64.zip\nsha512: arm64\n",
      );

      execFileSync(process.execPath, [join(root, ".github/actions/merge-mac-manifests/merge-mac-manifests.mjs")], {
        env: { ...process.env, INPUT_DIRECTORY: dir },
      });

      const merged = readFileSync(join(dir, "latest-mac.yml"), "utf8");
      expect(merged.indexOf("url: arm64.zip")).toBeLessThan(merged.indexOf("url: x64.zip"));
      expect(merged).toContain("path: arm64.zip");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores an existing latest-mac manifest when merging stable arch manifests", () => {
    const script = readFileSync(join(root, ".github/actions/merge-mac-manifests/merge-mac-manifests.mjs"), "utf8");

    expect(script).toContain("return /^(arm64|x64)-mac\\.yml$/.test(name);");
    expect(script).not.toContain('name === "latest-mac.yml"');
  });

  it("merges prerelease mac channel manifests separately from latest manifests", () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-desktop-release-"));
    try {
      writeFileSync(
        join(dir, "x64-mac.yml"),
        "version: 1.2.3\nfiles:\n  - url: x64.zip\n    sha512: x64\n    size: 2\npath: x64.zip\nsha512: x64\n",
      );
      writeFileSync(
        join(dir, "arm64-mac.yml"),
        "version: 1.2.3\nfiles:\n  - url: arm64.zip\n    sha512: arm64\n    size: 1\npath: arm64.zip\nsha512: arm64\n",
      );
      writeFileSync(
        join(dir, "x64-beta-mac.yml"),
        "version: 1.2.3-beta.1\nfiles:\n  - url: beta-x64.zip\n    sha512: beta-x64\n    size: 2\npath: beta-x64.zip\nsha512: beta-x64\n",
      );
      writeFileSync(
        join(dir, "arm64-beta-mac.yml"),
        "version: 1.2.3-beta.1\nfiles:\n  - url: beta-arm64.zip\n    sha512: beta-arm64\n    size: 1\npath: beta-arm64.zip\nsha512: beta-arm64\n",
      );

      execFileSync(process.execPath, [join(root, ".github/actions/merge-mac-manifests/merge-mac-manifests.mjs")], {
        env: { ...process.env, INPUT_DIRECTORY: dir },
      });
      execFileSync(process.execPath, [join(root, ".github/actions/merge-mac-manifests/merge-mac-manifests.mjs")], {
        env: { ...process.env, INPUT_DIRECTORY: dir, INPUT_OUTPUT: "beta-mac.yml", INPUT_CHANNEL: "beta" },
      });

      const latest = readFileSync(join(dir, "latest-mac.yml"), "utf8");
      const beta = readFileSync(join(dir, "beta-mac.yml"), "utf8");
      expect(latest).toContain("url: arm64.zip");
      expect(latest).toContain("url: x64.zip");
      expect(latest).not.toContain("beta-arm64.zip");
      expect(beta).toContain("url: beta-arm64.zip");
      expect(beta).toContain("url: beta-x64.zip");
      expect(beta).not.toContain("url: arm64.zip");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to architecture mac manifests when a prerelease channel manifest is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-desktop-release-"));
    try {
      writeFileSync(
        join(dir, "x64-mac.yml"),
        "version: 1.2.3-dev.1\nfiles:\n  - url: dev-x64.zip\n    sha512: dev-x64\n    size: 2\npath: dev-x64.zip\nsha512: dev-x64\n",
      );
      writeFileSync(
        join(dir, "arm64-mac.yml"),
        "version: 1.2.3-dev.1\nfiles:\n  - url: dev-arm64.zip\n    sha512: dev-arm64\n    size: 1\npath: dev-arm64.zip\nsha512: dev-arm64\n",
      );

      execFileSync(process.execPath, [join(root, ".github/actions/merge-mac-manifests/merge-mac-manifests.mjs")], {
        env: { ...process.env, INPUT_DIRECTORY: dir, INPUT_OUTPUT: "dev-mac.yml", INPUT_CHANNEL: "dev" },
      });

      const dev = readFileSync(join(dir, "dev-mac.yml"), "utf8");
      expect(dev).toContain("url: dev-arm64.zip");
      expect(dev).toContain("url: dev-x64.zip");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
