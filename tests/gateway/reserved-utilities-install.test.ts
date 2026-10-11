import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installApp as installLegacyApp, forkApp } from "../../packages/gateway/src/app-fork.js";
import { handleAppUpload } from "../../packages/gateway/src/app-upload.js";
import { renameApp } from "../../packages/gateway/src/app-ops.js";
import { installApp, installVerifiedApp } from "../../packages/gateway/src/app-runtime/install-flow.js";
import { invalidateAppIndexCache, resolveAppBySlug } from "../../packages/gateway/src/app-runtime/app-index.js";
import { generateTemplateManifest, smartSyncTemplate } from "../../packages/kernel/src/boot.js";

let root: string;
let home: string;
let source: string;
const manifest = (slug: string) => ({ name: "Uploaded app", slug, runtime: "static", version: "1.0.0", runtimeVersion: "^1.0.0", author: "system", listingTrust: "first_party" });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "reserved-utilities-"));
  home = join(root, "home");
  source = join(root, "source", "utilities");
  mkdirSync(source, { recursive: true });
  mkdirSync(join(home, "apps"), { recursive: true });
  writeFileSync(join(source, "matrix.json"), JSON.stringify(manifest("utilities")));
  writeFileSync(join(source, "index.html"), "untrusted payload");
  invalidateAppIndexCache();
});
afterEach(() => { invalidateAppIndexCache(); rmSync(root, { recursive: true, force: true }); });

function preserveBundledApp() {
  const bundled = join(home, "apps", "utilities");
  mkdirSync(bundled);
  writeFileSync(join(bundled, "index.html"), "bundled source");
  return () => {
    expect(readFileSync(join(bundled, "index.html"), "utf8")).toBe("bundled source");
    expect(readdirSync(join(home, "apps"))).toEqual(["utilities"]);
  };
}

describe("reserved Utilities install identity", () => {
  it("permits trusted template synchronization and preserves owner customizations", () => {
    const template = join(root, "template");
    const bundled = join(template, "apps", "utilities");
    mkdirSync(bundled, { recursive: true });
    writeFileSync(join(bundled, "index.html"), "bundled v1");
    const refreshManifest = () => writeFileSync(join(template, ".template-manifest.json"), JSON.stringify(generateTemplateManifest(template)));
    refreshManifest();
    expect(smartSyncTemplate(home, template).added).toContain("apps/utilities/index.html");
    const installed = join(home, "apps", "utilities", "index.html");
    writeFileSync(join(bundled, "index.html"), "bundled v2");
    refreshManifest();
    expect(smartSyncTemplate(home, template).updated).toContain("apps/utilities/index.html");
    expect(readFileSync(installed, "utf8")).toBe("bundled v2");
    writeFileSync(installed, "owner customization");
    writeFileSync(join(bundled, "index.html"), "bundled v3");
    refreshManifest();
    expect(smartSyncTemplate(home, template).skipped).toContain("apps/utilities/index.html");
    expect(readFileSync(installed, "utf8")).toBe("owner customization");
  });

  it.each(["community", "first_party", "verified_partner"])("rejects %s verified installs before replacing the bundled copy", async listingTrust => {
    const verify = preserveBundledApp();
    const result = await installVerifiedApp({ sourceDir: source, homeDir: home, listingTrust, declaredDistHash: "unused" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("install_blocked_by_policy");
    verify();
  });

  it("rejects the standard runtime installer even when the bundled copy is absent", async () => {
    const result = await installApp({ sourceDir: source, homeDir: home });
    expect(result.ok).toBe(false);
    expect(readdirSync(join(home, "apps"))).toEqual([]);
  });

  it.each(["utilities", "Utilities", "../apps/utilities", "utilities/assets"])("rejects legacy copy target %s before mutation", slug => {
    // Ordinary source identity cannot bypass the destination reservation.
    writeFileSync(join(source, "matrix.json"), JSON.stringify(manifest("ordinary")));
    expect(installLegacyApp({ sourceDir: source, homePath: home, slug }).success).toBe(false);
    expect(forkApp({ sourceDir: source, homePath: home, slug, author: "publisher", version: "1.0.0" }).success).toBe(false);
    expect(readdirSync(join(home, "apps"))).toEqual([]);
  });

  it("rejects copied source manifest impersonation at an ordinary destination", () => {
    expect(installLegacyApp({ sourceDir: source, homePath: home, slug: "ordinary" }).success).toBe(false);
    expect(forkApp({ sourceDir: source, homePath: home, slug: "ordinary", author: "publisher", version: "1.0.0" }).success).toBe(false);
    expect(existsSync(join(home, "apps", "ordinary"))).toBe(false);
  });

  it.each(["oversized", "directory", "symlink"])("rejects a %s source manifest before either legacy copy creates files", kind => {
    const manifestPath = join(source, "matrix.json");
    rmSync(manifestPath);
    if (kind === "oversized") writeFileSync(manifestPath, JSON.stringify({ ...manifest("ordinary"), description: "x".repeat(65_536) }));
    else if (kind === "directory") mkdirSync(manifestPath);
    else {
      const externalManifest = join(root, "external-matrix.json");
      writeFileSync(externalManifest, JSON.stringify(manifest("ordinary")));
      symlinkSync(externalManifest, manifestPath);
    }
    for (const result of [
      () => installLegacyApp({ sourceDir: source, homePath: home, slug: "ordinary" }),
      () => forkApp({ sourceDir: source, homePath: home, slug: "ordinary", author: "publisher", version: "1.0.0" }),
    ]) {
      expect(result()).toMatchObject({ success: false, error: expect.stringContaining("manifest") });
      expect(readdirSync(join(home, "apps"))).toEqual([]);
    }
  });

  it("retains bounded malformed-JSON compatibility without admitting a reserved destination", () => {
    writeFileSync(join(source, "matrix.json"), "not JSON");
    expect(installLegacyApp({ sourceDir: source, homePath: home, slug: "ordinary" }).success).toBe(true);
    expect(readFileSync(join(home, "apps", "ordinary", "matrix.json"), "utf8")).toBe("not JSON");
    expect(forkApp({ sourceDir: source, homePath: home, slug: "utilities", author: "publisher", version: "1.0.0" }).success).toBe(false);
    expect(existsSync(join(home, "apps", "utilities"))).toBe(false);
  });

  it("rejects explicit and inferred uploads without replacing existing work", () => {
    const verify = preserveBundledApp();
    for (const slug of ["utilities", undefined]) {
      const result = handleAppUpload(home, slug, { "matrix.json": JSON.stringify({ ...manifest("utilities"), name: "Utilities" }), "index.html": "untrusted payload" });
      expect(result.success).toBe(false);
      verify();
    }
  });

  it("rejects uploaded manifest impersonation at an ordinary destination", () => {
    expect(handleAppUpload(home, "ordinary", { "matrix.json": JSON.stringify(manifest("utilities")), "index.html": "untrusted payload" }).success).toBe(false);
    expect(existsSync(join(home, "apps", "ordinary"))).toBe(false);
  });

  it("rejects renaming another app into Utilities before changing its manifest", () => {
    const ordinary = join(home, "apps", "ordinary");
    mkdirSync(ordinary);
    const original = JSON.stringify(manifest("ordinary"));
    writeFileSync(join(ordinary, "matrix.json"), original);
    expect(renameApp(home, "ordinary", "Utilities").success).toBe(false);
    expect(readFileSync(join(ordinary, "matrix.json"), "utf8")).toBe(original);
    expect(existsSync(join(home, "apps", "utilities"))).toBe(false);
  });

  it("does not resolve a copied reserved manifest from an alternate directory", async () => {
    const alias = join(home, "apps", "ordinary", "nested");
    mkdirSync(alias, { recursive: true });
    writeFileSync(join(alias, "matrix.json"), JSON.stringify(manifest("utilities")));
    expect((await resolveAppBySlug(join(home, "apps"), "utilities")).ok).toBe(false);
  });

  it("keeps the exact bundled directory resolvable despite an impersonating alias", async () => {
    for (const location of ["utilities", "ordinary"]) {
      const dir = join(home, "apps", location);
      mkdirSync(dir);
      writeFileSync(join(dir, "matrix.json"), JSON.stringify(manifest("utilities")));
    }
    const result = await resolveAppBySlug(join(home, "apps"), "utilities");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entry.relativePath).toBe("utilities");
  });
});
