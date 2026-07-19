import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ICON_STYLE,
  buildIconPrompt,
  createImageClient,
} from "../packages/kernel/src/image-gen.js";
import { getPersonaSuggestions } from "../packages/kernel/src/onboarding.js";

const PERSONA_ROLES = [
  "student",
  "developer",
  "investor",
  "entrepreneur",
  "parent",
  "creative",
  "researcher",
  "general",
];

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const APPS_ROOT = join(REPO_ROOT, "home/apps");
const OUT_DIR = join(REPO_ROOT, "previews/icon-pack-081");
const MODEL = process.env.GEMINI_ICON_PREVIEW_MODEL
  ?? process.env.GEMINI_IMAGE_MODEL
  ?? "gemini-3.1-flash-image-preview";

interface IconCandidate {
  slug: string;
  label: string;
  source: string;
}

function appNameToSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function addCandidate(candidates: Map<string, IconCandidate>, candidate: IconCandidate): void {
  const existing = candidates.get(candidate.slug);
  if (!existing) {
    candidates.set(candidate.slug, candidate);
    return;
  }
  if (!existing.source.includes(candidate.source)) {
    candidates.set(candidate.slug, {
      ...existing,
      source: `${existing.source}, ${candidate.source}`,
    });
  }
}

async function collectManifestIcons(dir: string, candidates: Map<string, IconCandidate>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith("_template-")) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectManifestIcons(fullPath, candidates);
      continue;
    }
    if (entry.name !== "matrix.json") continue;

    try {
      const manifest = JSON.parse(await readFile(fullPath, "utf8")) as {
        name?: unknown;
        icon?: unknown;
        slug?: unknown;
      };
      const icon = typeof manifest.icon === "string" ? manifest.icon : undefined;
      const slug = typeof manifest.slug === "string" ? manifest.slug : icon;
      if (!icon || !slug || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(icon)) continue;
      addCandidate(candidates, {
        slug: icon,
        label: typeof manifest.name === "string" ? manifest.name : slug,
        source: "default app",
      });
    } catch (err) {
      console.warn("[icon-preview] skipped unreadable manifest:", fullPath, err instanceof Error ? err.message : String(err));
    }
  }
}

async function collectCandidates(): Promise<IconCandidate[]> {
  const candidates = new Map<string, IconCandidate>();
  await collectManifestIcons(APPS_ROOT, candidates);

  for (const role of PERSONA_ROLES) {
    for (const app of getPersonaSuggestions(role).apps) {
      const slug = appNameToSlug(app.name);
      addCandidate(candidates, {
        slug,
        label: app.name,
        source: `onboarding:${role}`,
      });
    }
  }

  return [...candidates.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

function renderIndex(candidates: IconCandidate[], failures: Array<{ slug: string; error: string }>): string {
  const cards = candidates.map((candidate) => {
    const file = `${candidate.slug}.png`;
    const status = existsSync(join(OUT_DIR, file)) ? "" : "missing";
    return `<article class="card ${status}">
      <img src="./${file}" alt="${candidate.label} icon" loading="lazy">
      <strong>${candidate.label}</strong>
      <code>${candidate.slug}</code>
      <span>${candidate.source}</span>
    </article>`;
  }).join("\n");

  const failed = failures.length === 0
    ? ""
    : `<section class="failures"><h2>Failures</h2><pre>${failures.map((f) => `${f.slug}: ${f.error}`).join("\n")}</pre></section>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Matrix OS Icon Preview Pack</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #f5f4ef; color: #32352e; }
    body { margin: 0; padding: 32px; }
    header { max-width: 1120px; margin: 0 auto 24px; }
    h1 { margin: 0 0 8px; font-size: 28px; font-weight: 720; letter-spacing: 0; }
    p { margin: 0; color: #5e6258; }
    .grid { max-width: 1120px; margin: 0 auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(148px, 1fr)); gap: 16px; }
    .card { background: #fffdf7; border: 1px solid #d9d8ca; border-radius: 8px; padding: 14px; display: grid; gap: 8px; min-width: 0; }
    img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 8px; background: #d1d3bc; border: 1px solid #c6c8b3; }
    strong, code, span { overflow-wrap: anywhere; }
    strong { font-size: 14px; }
    code { font-size: 12px; color: #434e3f; }
    span { font-size: 12px; color: #74786d; }
    .missing img { opacity: 0.2; }
    .failures { max-width: 1120px; margin: 24px auto 0; }
    pre { white-space: pre-wrap; background: #32352e; color: #e0e1ca; padding: 16px; border-radius: 8px; }
  </style>
</head>
<body>
  <header>
    <h1>Matrix OS Icon Preview Pack</h1>
    <p>Generated with ${MODEL}. Review only: these files are not shipped until copied into home/system/icons.</p>
  </header>
  <main class="grid">${cards}</main>
  ${failed}
</body>
</html>`;
}

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required");
  }

  await mkdir(OUT_DIR, { recursive: true });
  const candidates = await collectCandidates();
  const client = createImageClient(apiKey);
  const failures: Array<{ slug: string; error: string }> = [];

  for (const candidate of candidates) {
    const saveAs = `${candidate.slug}.png`;
    const outPath = join(OUT_DIR, saveAs);
    if (existsSync(outPath)) {
      console.log(`[icon-preview] exists ${saveAs}`);
      continue;
    }

    const prompt = buildIconPrompt(candidate.slug, DEFAULT_ICON_STYLE);
    console.log(`[icon-preview] generating ${saveAs}`);
    try {
      await client.generateImage(prompt, {
        model: MODEL,
        aspectRatio: "1:1",
        imageSize: "1K",
        imageDir: OUT_DIR,
        saveAs,
      });
    } catch (err) {
      failures.push({ slug: candidate.slug, error: err instanceof Error ? err.message : String(err) });
    }
  }

  await writeFile(join(OUT_DIR, "index.html"), renderIndex(candidates, failures));
  console.log(`[icon-preview] wrote ${join(OUT_DIR, "index.html")}`);
}

main().catch((err) => {
  console.error("[icon-preview] failed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
