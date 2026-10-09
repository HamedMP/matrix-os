import { getAppIdentity, getAppSlug, encodeAppSlugPath, type MatrixAppEntry } from "../lib/apps";

const app = (overrides: Partial<MatrixAppEntry>): MatrixAppEntry => ({
  name: "Notes",
  file: "notes/index.html",
  path: "/files/apps/notes/index.html",
  ...overrides,
});

describe("mobile app helpers", () => {
  it("retains the installed nested identity when the catalog exposes a migrated leaf runtime slug", () => {
    const entry = app({ slug: "chess", file: "games/chess/index.html", path: "/files/apps/games/chess/index.html" });
    expect(getAppSlug(entry)).toBe("chess");
    expect(getAppIdentity(entry)).toBe("games/chess");
    expect(getAppIdentity(app({ slug: "chess", file: "chess/index.html" }))).toBe("chess");
    expect(getAppIdentity(app({ slug: "chess", file: "private/chess/dist/index.html" }))).toBe("private/chess");
  });
  it("derives slugs from nested directory apps", () => {
    expect(getAppSlug(app({ file: "games/snake/index.html" }))).toBe("games/snake");
  });

  it("derives slugs from legacy html apps", () => {
    expect(getAppSlug(app({ file: "calculator.html" }))).toBe("calculator");
  });

  it("normalizes slugs from gateway paths with casing, duplicate slashes, and cache params", () => {
    expect(getAppSlug(app({
      name: "Notes",
      file: "/files/apps//Notes/index.html?v=abc#top",
      path: "/files/apps//Notes/index.html?v=abc#top",
    }))).toBe("notes");
  });

  it("falls back to a safe name slug for unsafe app paths", () => {
    expect(getAppSlug(app({
      name: "Internal Secrets",
      file: "../system/secrets/index.html",
      path: "/files/apps/../system/secrets/index.html",
    }))).toBe("internal-secrets");
  });

  it("encodes nested runtime slug path segments without escaping separators", () => {
    expect(encodeAppSlugPath("games/snake board")).toBe("games/snake%20board");
  });
});
