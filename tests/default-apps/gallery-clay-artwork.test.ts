import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { galleryArtwork, galleryIdentitySources } from "../../home/apps/app-gallery/src/artwork";

const supplied = ["atlas", "folio", "subscriptions", "agenda", "focus", "workout-coach", "expense-tracker", "todo", "game-center"];

describe("Figma clay identity artwork", () => {
  it.each(supplied)("packages the original %s SVG with its master dimensions", (slug) => {
    const text = readFileSync(resolve("home/apps/app-gallery/src/assets/clay", `${slug}.svg`), "utf8");
    const root = text.match(/<svg\b[^>]*>/)?.[0];
    expect(root).toMatch(/width="128"/);
    expect(root).toMatch(/height="128"/);
    expect(text).not.toContain("www.figma.com/api/mcp/asset/");
  });

  it("prefers the supplied semantic icon and retains both existing fallback formats", () => {
    expect(galleryIdentitySources({ id: "folio", icon: "folio" })).toEqual([
      galleryArtwork("clay/folio.svg"), galleryArtwork("icons/folio.png"), galleryArtwork("icons/folio.svg"),
    ]);
  });

  it("keeps unrelated app identities rather than assigning a generic clay object", () => {
    expect(galleryIdentitySources({ id: "chess-coach", icon: "chess" })).toEqual([
      galleryArtwork("icons/chess-coach.png"), galleryArtwork("icons/chess.svg"),
    ]);
    expect(galleryIdentitySources({ id: "unpackaged-app", icon: "unknown" })).toEqual([]);
  });
});
