import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { containsDeniedFileApiPath, isDeniedFileApiPath } from "../../packages/gateway/src/path-security";

describe("private gallery installation staging", () => {
  it("blocks workspace grants and ordinary file APIs from exposing staging", () => {
    const home = "/owner/home";
    expect(isDeniedFileApiPath(home, "data/app-gallery-staging")).toBe(true);
    expect(isDeniedFileApiPath(home, "data/app-gallery-staging/pending/index.html")).toBe(true);
    expect(containsDeniedFileApiPath(home, "/owner/home/data")).toBe(true);
    expect(containsDeniedFileApiPath(home, "/owner/home/data/app-gallery-staging")).toBe(true);
    expect(isDeniedFileApiPath(home, "data/app-gallery-staging-not-private")).toBe(false);
    expect(isDeniedFileApiPath(home, "apps/folio/index.html")).toBe(false);
  });
});

describe("reserved file API path classification", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "matrix-path-classification-"));
    await mkdir(join(home, "system"));
    await symlink(join(home, "system"), join(home, "settings-alias"), "dir");
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it.each([
    "settings-alias/notifications.json",
    "settings-alias/coding-agents/notification-preferences/owner.json",
  ])("classifies missing reserved descendants through an existing ancestor: %s", (path) => {
    expect(existsSync(join(home, path))).toBe(false);
    expect(isDeniedFileApiPath(home, path)).toBe(true);
  });

  it("classifies an absent ancestor of reserved state through its existing parent", () => {
    const ancestor = join(home, "settings-alias/coding-agents");
    expect(existsSync(ancestor)).toBe(false);
    expect(containsDeniedFileApiPath(home, ancestor)).toBe(true);
  });

  it("keeps absent neighboring paths available", () => {
    expect(isDeniedFileApiPath(home, "settings-alias/notifications.json.backup")).toBe(false);
    expect(isDeniedFileApiPath(home, "settings-alias/coding-agents/projects/new.json")).toBe(false);
    expect(containsDeniedFileApiPath(home, join(home, "settings-alias/coding-agents/projects"))).toBe(false);
  });
});
