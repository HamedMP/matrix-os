import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureDesktopIdentity, resolveDesktopIdentity, type DesktopIdentityOptions } from "@desktop/main/desktop-identity";

const resolveDesktopAppName = (options: DesktopIdentityOptions) => resolveDesktopIdentity(options).appName;

describe("Desktop QA native storage identity", () => {
  let root: string;
  let options: DesktopIdentityOptions;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "eng93-identity-"));
    const appDataDir = join(root, "apps");
    const userDataDir = join(root, "qa");
    mkdirSync(join(appDataDir, "Matrix OS"), { recursive: true });
    mkdirSync(userDataDir);
    options = { isPackaged: false, qaIdentity: "isolated", appDataDir, userDataDir };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("keeps the production name unless QA isolation is explicitly requested", () => {
    expect(resolveDesktopAppName({ ...options, qaIdentity: undefined })).toBe("Matrix OS");
    expect(resolveDesktopAppName({ ...options, qaIdentity: undefined, isPackaged: true })).toBe("Matrix OS");
    expect(resolveDesktopAppName({ ...options, qaIdentity: undefined, appDataDir: join(root, "absent") })).toBe("Matrix OS");
  });
  it("separates the native keychain namespace and keeps it stable for one canonical profile", () => {
    const path = realpathSync(options.userDataDir!);
    const canonical = process.platform === "darwin" ? path.normalize("NFC").toLowerCase() : path;
    const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
    expect(resolveDesktopAppName(options)).toBe(`Matrix OS QA ${hash}`);
    expect(resolveDesktopAppName({ ...options, userDataDir: join(root, "qa", "..", "qa") })).toBe(resolveDesktopAppName(options));
    const other = join(root, "another-qa"); mkdirSync(other);
    expect(resolveDesktopAppName({ ...options, userDataDir: other })).not.toBe(resolveDesktopAppName(options));
  });
  it.each(["", "true", "1", "isolated\n"])("rejects an unrecognized explicit QA setting %j", qaIdentity => {
    expect(() => resolveDesktopAppName({ ...options, qaIdentity })).toThrow(/QA identity/);
  });
  it("rejects QA identity on a packaged app", () => {
    expect(() => resolveDesktopAppName({ ...options, isPackaged: true })).toThrow(/QA identity/);
  });
  it.each([undefined, "relative-qa"])("requires an independent absolute profile %j", userDataDir => {
    expect(() => resolveDesktopAppName({ ...options, userDataDir })).toThrow(/QA identity/);
  });
  it("requires an existing directory, so a missing ancestor cannot hide an alias", () => {
    expect(() => resolveDesktopAppName({ ...options, userDataDir: join(root, "missing") })).toThrow(/QA identity/);
  });
  it("refuses a file as the QA profile", () => {
    const file = join(root, "file"); writeFileSync(file, "test", { flag: "wx" });
    expect(() => resolveDesktopAppName({ ...options, userDataDir: file })).toThrow(/QA identity/);
  });
  it("refuses an unavailable application-data directory", () => {
    expect(() => resolveDesktopAppName({ ...options, appDataDir: join(root, "absent") })).toThrow(/QA identity/);
  });
  it("allows independent QA before a production profile has ever been created", () => {
    rmSync(join(options.appDataDir, "Matrix OS"), { recursive: true });
    expect(resolveDesktopAppName(options)).toMatch(/^Matrix OS QA [a-f0-9]{16}$/);
  });
  it("rejects production, normalized, parent and child profiles before native storage can start", () => {
    const production = join(options.appDataDir, "Matrix OS");
    const child = join(production, "test"); mkdirSync(child);
    for (const userDataDir of [production, join(production, "..", "Matrix OS"), options.appDataDir, child, root]) {
      expect(() => resolveDesktopAppName({ ...options, userDataDir })).toThrow(/QA identity/);
    }
  });
  it("rejects symlink aliases of the production profile and its parents", () => {
    const alias = join(root, "production-alias"); symlinkSync(join(options.appDataDir, "Matrix OS"), alias);
    expect(() => resolveDesktopAppName({ ...options, userDataDir: alias })).toThrow(/QA identity/);
    const parentAlias = join(root, "app-alias"); symlinkSync(options.appDataDir, parentAlias);
    expect(() => resolveDesktopAppName({ ...options, userDataDir: join(parentAlias, "Matrix OS") })).toThrow(/QA identity/);
  });
  it("preserves identity when a legitimate QA directory has a path alias", () => {
    const alias = join(root, "qa-alias"); symlinkSync(options.userDataDir!, alias);
    expect(resolveDesktopAppName({ ...options, userDataDir: alias })).toBe(resolveDesktopAppName(options));
  });
  it("protects the logical and actual production trees when production is redirected", () => {
    const production = join(options.appDataDir, "Matrix OS");
    const target = join(root, "production-elsewhere"); mkdirSync(target);
    rmSync(production, { recursive: true }); symlinkSync(target, production);
    for (const userDataDir of [target, options.appDataDir, production]) {
      expect(() => resolveDesktopAppName({ ...options, userDataDir })).toThrow(/QA identity/);
    }
  });
  it("uses the validated directory even if its input alias is redirected before setPath", () => {
    const original = realpathSync(options.userDataDir!);
    const alias = join(root, "mutable-qa-alias"); symlinkSync(original, alias);
    const setPath = vi.fn();
    configureDesktopIdentity({
      isPackaged: false,
      getPath: () => options.appDataDir,
      setName: () => { rmSync(alias); symlinkSync(join(options.appDataDir, "Matrix OS"), alias); },
      setPath,
    }, { qaIdentity: "isolated", userDataDir: alias });
    expect(setPath).toHaveBeenCalledWith("userData", original);
  });
  it("applies no identity or path on invalid QA configuration", () => {
    const setName = vi.fn(), setPath = vi.fn();
    expect(() => configureDesktopIdentity({ isPackaged: true, getPath: () => options.appDataDir, setName, setPath }, options)).toThrow(/QA identity/);
    expect(setName).not.toHaveBeenCalled(); expect(setPath).not.toHaveBeenCalled();
  });
  it("keeps legacy product naming and path override without the QA flag", () => {
    const setName = vi.fn(), setPath = vi.fn();
    configureDesktopIdentity({ isPackaged: true, getPath: () => options.appDataDir, setName, setPath }, { userDataDir: "legacy-path" });
    expect(setName).toHaveBeenCalledWith("Matrix OS");
    expect(setPath).toHaveBeenCalledWith("userData", "legacy-path");
  });
});
