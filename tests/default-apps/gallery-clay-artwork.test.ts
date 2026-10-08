import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { galleryArtwork, galleryIdentitySources } from "../../home/apps/app-gallery/src/artwork";

const supplied = ["atlas", "folio", "subscriptions", "agenda", "focus", "workout-coach", "expense-tracker", "todo", "game-center"];

describe("Gallery identity artwork", () => {
  it.each(supplied)("packages the original %s SVG with its master dimensions", (slug) => {
    const text = readFileSync(resolve("home/apps/app-gallery/src/assets/clay", `${slug}.svg`), "utf8");
    const root = text.match(/<svg\b[^>]*>/)?.[0];
    expect(root).toMatch(/width="128"/);
    expect(root).toMatch(/height="128"/);
    expect(text).not.toContain("www.figma.com/api/mcp/asset/");
  });

  it("keeps the required design skill aligned with the generator's distinct icon default", () => {
    const skill = readFileSync("skills/matrix/design-system/SKILL.md", "utf8");
    expect(skill).toContain("mixed silhouettes");
    expect(skill).toContain("owner's iconStyle");
    expect(skill).not.toContain("light premium iOS/macOS skeuomorphic artwork");
  });

  it("prefers the supplied semantic icon and retains both existing fallback formats", () => {
    expect(galleryIdentitySources({ id: "folio", icon: "folio" })).toEqual([
      galleryArtwork("icons/folio.png"), galleryArtwork("clay/folio.svg"), galleryArtwork("icons/folio.svg"),
    ]);
  });

  it("ships the same first-party icon bytes to the Gallery and installed launcher", () => {
    const catalog = JSON.parse(readFileSync("home/system/app-gallery.json", "utf8")) as { apps: Array<{ id: string }> };
    for (const { id } of catalog.apps) {
      expect(readFileSync(`home/system/icons/gallery-${id}.png`)).toEqual(
        readFileSync(`home/apps/app-gallery/src/assets/icons/${id}.png`),
      );
    }
  });

  it("keeps unrelated app identities rather than assigning a generic clay object", () => {
    expect(galleryIdentitySources({ id: "chess-coach", icon: "chess" })).toEqual([
      galleryArtwork("icons/chess-coach.png"), galleryArtwork("icons/chess.svg"),
    ]);
    expect(galleryIdentitySources({ id: "unpackaged-app", icon: "unknown" })).toEqual([]);
  });
});
