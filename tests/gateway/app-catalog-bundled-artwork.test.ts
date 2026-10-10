import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { listAppCatalog } from "../../packages/gateway/src/apps";

it.each(["notes", "whiteboard"])("does not expose legacy %s snapshot artwork when canonical artwork is selected", async (slug) => {
  const home = await mkdtemp(join(tmpdir(), "catalog-artwork-"));
  try {
    await mkdir(join(home, "apps", slug), { recursive: true });
    await mkdir(join(home, "system/icons"), { recursive: true });
    await writeFile(join(home, "system/icons", `${slug}.png`), await readFile(new URL(`../../home/system/icons/${slug}.png`, import.meta.url)));
    await writeFile(join(home, "apps", slug, "index.html"), "<html></html>");
    await writeFile(join(home, "apps", slug, "matrix.json"), JSON.stringify({ name: slug, slug, icon: slug, version: "1.0.0", runtimeVersion: "^24.0.0", runtime: "static" }));
    const catalog = await listAppCatalog(home);
    expect(catalog.apps[0]?.iconUrl).toBe(`/system-app-icons/v2/${slug}.png`);
    expect(catalog.icons[slug]).toBeUndefined();
    await writeFile(join(home, "system/icons", `${slug}.png`), "owner artwork");
    const customized = await listAppCatalog(home);
    expect(customized.apps[0]?.iconUrl).toMatch(new RegExp(`^/icons/${slug}\\.png\\?v=`));
    expect(customized.icons[slug]?.versionedUrl).toBe(customized.apps[0]?.iconUrl);
  } finally { await rm(home, { recursive: true, force: true }); }
});
