import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Status fills (--success, --warning, --danger, --info) are tuned for solid
// buttons, dots and borders. Text and status glyphs must use the matching
// *-text token, which is contrast-checked against status tints and surfaces.
const ROOTS = [
  path.resolve(import.meta.dirname, "../../desktop/src/renderer/src"),
  path.resolve(import.meta.dirname, "../../packages/ui/src"),
];
const FILL = String.raw`var\(\s*--(?:success|warning|danger|info)\s*\)`;
// A fill named only as the last fallback of another variable is allowed.
const PRIMARY_FILL = new RegExp(String.raw`(?<!,\s*)${FILL}`);
const STYLE_COLOR = /(?<![\w-])color\s*:\s*([^,;}]*)/g;
const TAILWIND_TEXT = new RegExp(String.raw`(?<![\w-])text-\[(?:color:)?${FILL}\]`, "g");

function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSources(full, out);
    else if (/\.(ts|tsx|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function findFillTokensUsedAsText(file: string, source: string): string[] {
  const findings: string[] = [];
  const relative = path.relative(path.resolve(import.meta.dirname, "../.."), file);
  for (const match of source.matchAll(STYLE_COLOR)) {
    if (PRIMARY_FILL.test(match[1]!)) findings.push(`${relative}:${lineOf(source, match.index!)} color: ${match[1]!.trim()}`);
  }
  for (const match of source.matchAll(TAILWIND_TEXT)) {
    findings.push(`${relative}:${lineOf(source, match.index!)} ${match[0]}`);
  }
  return findings;
}

describe("status text tokens", () => {
  it("detects fill tokens used as text in style objects, CSS and Tailwind classes", () => {
    const sample = [
      `<span style={{ background: "var(--warning-muted)", color: "var(--warning)" }} />`,
      `<p style={{ color: failed ? "var(--danger)" : "var(--text-tertiary)" }} />`,
      `.label { color: var(--success); }`,
      `<b className="hover:text-[var(--info)]" />`,
    ].join("\n");
    expect(findFillTokensUsedAsText("/sample.tsx", sample)).toHaveLength(4);
  });

  it("allows fills on backgrounds, borders, dots and as a last fallback", () => {
    const sample = [
      `<span style={{ background: "var(--warning)", borderColor: "var(--danger)", color: "var(--text-on-warning)" }} />`,
      `<StatusDot color="var(--success)" />`,
      `<span className="bg-[var(--danger)] text-[var(--danger-text)]" />`,
      `<button style={{ color: "var(--danger-text, var(--destructive-text, var(--danger)))" }} />`,
    ].join("\n");
    expect(findFillTokensUsedAsText("/sample.tsx", sample)).toEqual([]);
  });

  it("keeps Electron Desktop and shared UI status labels on accessible text tokens", () => {
    const findings = ROOTS.flatMap((root) => collectSources(root))
      .flatMap((file) => findFillTokensUsedAsText(file, readFileSync(file, "utf8")));
    expect(findings).toEqual([]);
  });
});
