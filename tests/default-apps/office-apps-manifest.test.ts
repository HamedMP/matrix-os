import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseManifest } from "../../packages/gateway/src/app-runtime/manifest-schema";

// The office suite apps (spec 2710) must satisfy the same shipped-default-app
// gates as manifest-quality.test.ts, plus the suite-specific scaffold rules:
// first-party trust, the files permission for document editors, shared-source
// build inputs, and app-local isolation from the root pnpm workspace.

const REPO_ROOT = join(__dirname, "..", "..");
const APPS_DIR = join(REPO_ROOT, "home", "apps");
const ICONS_DIR = join(REPO_ROOT, "home", "system", "icons");
const OFFICE_APPS = ["docs"] as const;
/** Apps that edit owner files. */
const FILE_APPS = new Set<string>(["docs"]);

interface Manifest {
  name?: string;
  slug?: string;
  runtime?: string;
  runtimeVersion?: string;
  icon?: string;
  author?: string;
  scope?: string;
  listingTrust?: string;
  permissions?: string[];
  hidden?: boolean;
  build?: { install?: string; command?: string; output?: string; sourceGlobs?: string[] };
}

const readText = (app: string, file: string) => readFileSync(join(APPS_DIR, app, file), "utf-8");
const readJson = <T>(app: string, file: string): T => JSON.parse(readText(app, file)) as T;

function iconExists(iconSlug: string): boolean {
  return existsSync(join(ICONS_DIR, `${iconSlug}.svg`)) || existsSync(join(ICONS_DIR, `${iconSlug}.png`));
}

describe.each(OFFICE_APPS)("office app %s", (app) => {
  const manifest = readJson<Manifest>(app, "matrix.json");

  it("parses with the gateway manifest schema", async () => {
    const result = await parseManifest(manifest);
    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
  });

  it("is a visible vite app that builds to dist", () => {
    expect(manifest.runtime).toBe("vite");
    expect(manifest.runtimeVersion).toBe("^1.0.0");
    expect(manifest.build?.output).toBe("dist");
    expect(manifest.build?.command).toBe("pnpm build");
    expect(manifest.build?.install).toBe("pnpm install --ignore-workspace --prefer-offline");
    expect(manifest.hidden).not.toBe(true);
  });

  it("declares a slug equal to its directory", () => {
    expect(manifest.slug).toBe(app);
  });

  it("has an icon backed by a shipped icon asset", () => {
    expect(manifest.icon).toBeTruthy();
    expect(iconExists(manifest.icon as string), `home/system/icons/${manifest.icon}.svg|png`).toBe(true);
  });

  it("is a first-party personal system app", () => {
    expect(manifest.author).toBe("system");
    expect(manifest.scope).toBe("personal");
    expect(manifest.listingTrust).toBe("first_party");
  });

  it("requests the files permission only when it reads or writes owner files", () => {
    const permissions = manifest.permissions ?? [];
    if (FILE_APPS.has(app)) expect(permissions).toEqual(["files"]);
    else expect(permissions).not.toContain("files");
  });

  it("rebuilds when shared office sources or canonical icons change", () => {
    const globs = manifest.build?.sourceGlobs ?? [];
    for (const glob of ["src/**", "../_shared/**", "index.html", "matrix.json", "package.json", "vite.config.ts", "tsconfig.json", "../../system/icons/v3-*.png"]) {
      expect(globs).toContain(glob);
    }
  });

  it("is an isolated pnpm project with a lockfile and a dist-producing build script", () => {
    expect(existsSync(join(APPS_DIR, app, "pnpm-lock.yaml"))).toBe(true);
    expect(readText(app, "pnpm-workspace.yaml")).toMatch(/packages:\s*\[\]/);
    const pkg = readJson<{ name: string; scripts: Record<string, string>; dependencies: Record<string, string> }>(app, "package.json");
    expect(pkg.name).toBe(`@matrixos/${app}`);
    expect(pkg.scripts.build).toContain("vite build");
    // The engine copy is generated, not committed: regenerate (or, on an owner's computer, verify) it first.
    expect(pkg.scripts.build).toMatch(/^node \.\.\/_shared\/ensure-office-engine\.mjs && /);
    expect(pkg.dependencies.react).toBe("19.2.6");
    expect(pkg.dependencies["react-dom"]).toBe("19.2.6");
  });

  it("type-checks the shared office kit, engine and bridge typings", () => {
    const tsconfig = readJson<{ include: string[]; compilerOptions: { paths?: Record<string, string[]> } }>(app, "tsconfig.json");
    for (const path of ["src", "../_shared/office-ui", "../_shared/office-engine", "../_shared/matrix-os.d.ts"]) {
      expect(tsconfig.include).toContain(path);
    }
    // Shared sources must resolve the app's own React types, not the root workspace copy.
    expect(tsconfig.compilerOptions.paths?.react).toEqual(["./node_modules/@types/react"]);
  });

  it("dedupes React so shared office components share the app's React instance", () => {
    const vite = readText(app, "vite.config.ts");
    expect(vite).toContain('base: "./"');
    expect(vite).toContain('outDir: "dist"');
    expect(vite).toMatch(/dedupe:\s*\["react",\s*"react-dom"\]/);
  });

  it("loads the brand after local styling and identifies its own accent", () => {
    const main = readText(app, "src/main.tsx");
    expect(main).toContain(`dataset.app = "${app}"`);
    expect(main).toContain("../../_shared/office-ui/office-ui.css");
    expect(main).toContain("../../_shared/app-identities.css");
    expect(main.lastIndexOf("matrix-brand.css")).toBeGreaterThan(main.lastIndexOf("styles.css"));
  });

  it("has an accessible identity accent", () => {
    const identities = JSON.parse(readFileSync(join(REPO_ROOT, "packages/brand/src/app-identities.json"), "utf-8")) as Record<string, { accent: string }>;
    expect(identities[app]?.accent).toMatch(/^#[0-9a-f]{6}$/i);
    const css = readFileSync(join(APPS_DIR, "_shared", "app-identities.css"), "utf-8");
    expect(css).toContain(`[data-app="${app}"]`);
  });
});
