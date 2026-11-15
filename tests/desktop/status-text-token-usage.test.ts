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
// The Tailwind theme aliases (--color-success etc.) resolve to the same fills.
// A fill is matched whether it ends the var() or starts a fallback chain: var(--danger, var(--x)).
const FILL = String.raw`var\(\s*--(?:color-)?(?:success|warning|danger|info)\s*[,)]`;
// A fill named only as the last fallback of another variable is allowed.
const PRIMARY_FILL = new RegExp(String.raw`(?<!,\s*)${FILL}`);
// The value runs to the first comma (kept, so a fill starting a fallback chain is visible).
const STYLE_COLOR = /(?<![\w-])color\s*:\s*([^,;}]*,?)/g;
// A constant (string, ternary or status map, optionally type-annotated) whose value contains a primary fill.
const FILL_CONSTANT = /(?<![\w$])const\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=([^;]*);/g;
const TAILWIND_TEXT = new RegExp(String.raw`(?<![\w-])text-\[(?:color:)?${FILL}`, "g");

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
  const fillConstants = new Set<string>();
  for (const match of source.matchAll(FILL_CONSTANT)) {
    if (PRIMARY_FILL.test(match[2]!)) fillConstants.add(match[1]!);
  }
  for (const match of source.matchAll(STYLE_COLOR)) {
    const value = match[1]!.trim();
    const reference = /^([A-Za-z_$][\w$]*)(?:\[|\s*,?$)/.exec(value)?.[1];
    if (PRIMARY_FILL.test(value) || (reference && fillConstants.has(reference))) {
      findings.push(`${relative}:${lineOf(source, match.index!)} color: ${value}`);
    }
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

  it("detects fills and their --color-* aliases that reach text through variables and maps", () => {
    const sample = [
      `const previewColor = ok ? "var(--success)" : failed ? "var(--danger)" : "var(--text-tertiary)";`,
      `const STATUS_COLOR = {`,
      `  done: "var(--color-success)",`,
      `  error: "var(--color-danger)",`,
      `} as const;`,
      `<span style={{ borderColor: "var(--border-default)", color: previewColor, fontSize: 12 }} />`,
      `<span style={{ color: STATUS_COLOR[terminal.status] }} />`,
      `<i style={{ color: "var(--color-warning)" }} />`,
      `const AVAILABILITY_COLOR: Record<Availability, string> = { available: "var(--color-success)" };`,
      `<em style={{ color: AVAILABILITY_COLOR[computer.availability] }} />`,
    ].join("\n");
    expect(findFillTokensUsedAsText("/sample.tsx", sample)).toHaveLength(4);
  });

  it("detects fills used first in a fallback chain", () => {
    const sample = [
      `.state { color: var(--success, var(--import-accent)); }`,
      `<Menu.Item style={item.danger ? {color:"var(--danger, var(--destructive))"} : undefined} />`,
      `<p style={{ color: "var( --color-warning , #e0aa52)" }} />`,
    ].join("\n");
    expect(findFillTokensUsedAsText("/sample.tsx", sample)).toHaveLength(3);
  });

  it("allows a fallback chain that starts with a text token", () => {
    const sample = [
      `.state { color: var(--success-text, var(--success, var(--import-accent))); }`,
      `<Menu.Item style={{ color: "var(--danger-text, var(--destructive-text, var(--danger)))" }} />`,
    ].join("\n");
    expect(findFillTokensUsedAsText("/sample.tsx", sample)).toEqual([]);
  });

  it("allows fill variables that only reach backgrounds, borders and dots", () => {
    const sample = [
      `const dotColor = ok ? "var(--success)" : "var(--danger)";`,
      `const labelColor = ok ? "var(--success-text, var(--color-success))" : "var(--text-tertiary)";`,
      `<span style={{ background: dotColor, borderColor: dotColor, color: labelColor }} />`,
      `<StatusDot color={dotColor} />`,
    ].join("\n");
    expect(findFillTokensUsedAsText("/sample.tsx", sample)).toEqual([]);
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

describe("interactive highlight surfaces", () => {
  // Electron Desktop's --accent is its near-white primary fill; highlighting a row
  // or button with it hides the light label. Highlights use --bg-hover instead.
  const ACCENT_HIGHLIGHT = /(?<![\w-])(?:focus|hover|focus-visible|data-\[highlighted\]):bg-accent(?![\w-])/g;

  it("detects accent fills used as hover and focus highlights", () => {
    const sample = `<a className="focus:bg-accent" /><b className="hover:bg-accent underline" /><i className="focus:bg-[var(--bg-hover,var(--accent))] hover:bg-accent-hover" />`;
    expect(sample.match(ACCENT_HIGHLIGHT)).toEqual(["focus:bg-accent", "hover:bg-accent"]);
  });

  it("keeps Electron Desktop and shared UI highlights off the accent fill", () => {
    const findings = ROOTS.flatMap((root) => collectSources(root)).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return [...source.matchAll(ACCENT_HIGHLIGHT)].map((match) => `${path.relative(path.resolve(import.meta.dirname, "../.."), file)}:${lineOf(source, match.index!)} ${match[0]}`);
    });
    expect(findings).toEqual([]);
  });
});
