# Slice 1 — Brand foundation (`@matrix-os/brand`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the landing brand (tokens + a small React primitive set) into a shared `@matrix-os/brand` package consumed by `www` and `shell`, and unify the conflicting `onboarding-brand.ts` onto it — with zero product-behavior change.

**Architecture:** New private workspace package `packages/brand`. `www` landing `theme.ts` re-exports from it (existing imports keep working). `shell/src/lib/onboarding-brand.ts` is redefined to alias canonical tokens. Primitives ship as framework-light React components (peer dep React) so both Next apps and Slice 3's shell screens reuse them.

**Tech Stack:** TypeScript 5.5+ strict, ES modules, `tsc` build, React 19 peer dep, Vitest. Follows `@matrix-os/observability` package conventions.

## Global Constraints

- Branch: continue on the active onboarding branch / a manual worktree. Never commit to `main`.
- Canonical tokens (verbatim): forest `#434E3F`, forestDeep `#2E3A2A`, deep `#32352E`, cream `#E0E1CA`, ember `#D06F25`, pageBg `#EEEEE2`, card `#FCFCF8`, border `#DCD9CC`, mutedFg `#5C5A4F`, subtle `#7A7768`. Fonts: display = Instrument Serif, body = Instrument Sans. cardShadow `0 0 7.5rem 0 rgba(50,53,46,0.09)`, cardShadowSmall `0 0 3rem 0 rgba(50,53,46,0.07)`.
- Package is `private: true`, `type: module`, name `@matrix-os/brand`, version `0.0.1`, consumed as `workspace:*`.
- No product-behavior or visible change to existing screens beyond `onboarding-brand.ts` color values converging to canonical (those screens are removed in Slice 3 anyway).
- React changes → `npx react-doctor@latest` on the package consumers before commit.
- vitest alias `@` → `shell/src`; tests import the package by bare name `@matrix-os/brand` (add alias to `vitest.config.ts`).

---

### Task 1: Scaffold the `@matrix-os/brand` package with tokens

**Files:**
- Create: `packages/brand/package.json`
- Create: `packages/brand/tsconfig.json`
- Create: `packages/brand/src/tokens.ts`
- Create: `packages/brand/src/index.ts`
- Test: `tests/brand/tokens.test.ts`

**Interfaces:**
- Produces (from `@matrix-os/brand`):
  - `const palette: { forest; forestDeep; deep; cream; ember; pageBg; card; border; mutedFg; subtle }` (all string hex)
  - `const fonts: { display: string; sans: string }`
  - `const cardShadow: string`, `const cardShadowSmall: string`
  - `const radii: { control: string; card: string; pill: string }`
  - `const typeScale: { display: string; h1: string; h2: string; body: string; caption: string }`

- [ ] **Step 1: Write the failing token test**

```ts
// tests/brand/tokens.test.ts
import { describe, expect, it } from "vitest";
import { palette, fonts, cardShadow } from "@matrix-os/brand";

describe("@matrix-os/brand tokens", () => {
  it("exposes the canonical landing palette", () => {
    expect(palette.forest).toBe("#434E3F");
    expect(palette.ember).toBe("#D06F25");
    expect(palette.cream).toBe("#E0E1CA");
    expect(palette.pageBg).toBe("#EEEEE2");
    expect(palette.card).toBe("#FCFCF8");
    expect(palette.border).toBe("#DCD9CC");
    expect(palette.deep).toBe("#32352E");
  });
  it("exposes Instrument display + sans fonts", () => {
    expect(fonts.display).toContain("Instrument Serif");
    expect(fonts.sans).toContain("Instrument Sans");
  });
  it("exposes the landing card shadow", () => {
    expect(cardShadow).toBe("0 0 7.5rem 0 rgba(50, 53, 46, 0.09)");
  });
});
```

- [ ] **Step 2: Add the vitest alias, then run the test to verify it fails**

In `vitest.config.ts` `resolve.alias`, add (next to the other `@matrix-os/*` aliases):

```ts
      "@matrix-os/brand": path.resolve(__dirname, "packages/brand/src/index.ts"),
```

Run: `bun run test -- tests/brand/tokens.test.ts`
Expected: FAIL — `packages/brand/src/index.ts` does not exist.

- [ ] **Step 3: Create the package manifest + tsconfig**

```json
// packages/brand/package.json
{
  "name": "@matrix-os/brand",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    },
    "./tokens": {
      "types": "./src/tokens.ts",
      "import": "./dist/tokens.js",
      "default": "./dist/tokens.js"
    }
  },
  "scripts": { "build": "tsc" },
  "peerDependencies": { "react": "^19.0.0" },
  "devDependencies": { "@types/node": "^25.2.3", "@types/react": "^19.0.0", "typescript": "^5.9.3" }
}
```

```json
// packages/brand/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"],
    "jsx": "react-jsx",
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Create tokens + index**

```ts
// packages/brand/src/tokens.ts
export const palette = {
  forest: "#434E3F",
  forestDeep: "#2E3A2A",
  deep: "#32352E",
  cream: "#E0E1CA",
  ember: "#D06F25",
  pageBg: "#EEEEE2",
  card: "#FCFCF8",
  border: "#DCD9CC",
  mutedFg: "#5C5A4F",
  subtle: "#7A7768",
} as const;

export const fonts = {
  display: "var(--font-serif-display), 'Instrument Serif', Georgia, serif",
  sans: "var(--font-instrument), 'Instrument Sans', system-ui, sans-serif",
} as const;

export const cardShadow = "0 0 7.5rem 0 rgba(50, 53, 46, 0.09)";
export const cardShadowSmall = "0 0 3rem 0 rgba(50, 53, 46, 0.07)";

export const radii = { control: "0.625rem", card: "12px", pill: "999px" } as const;

export const typeScale = {
  display: "clamp(2.5rem, 6vw, 4.4rem)",
  h1: "2rem",
  h2: "1.5rem",
  body: "1rem",
  caption: "0.8125rem",
} as const;
```

```ts
// packages/brand/src/index.ts
export * from "./tokens.js";
export * from "./primitives.js";
```

> Note: `index.ts` re-exports `./primitives.js`, added in Task 2. Until then, temporarily export only `./tokens.js` so this task's test passes; Task 2 adds the primitives export back. (Implementer: set `export * from "./tokens.js";` only for this step.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test -- tests/brand/tokens.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/brand/package.json packages/brand/tsconfig.json packages/brand/src/tokens.ts packages/brand/src/index.ts vitest.config.ts tests/brand/tokens.test.ts
git commit -m "feat(brand): scaffold @matrix-os/brand tokens package"
```

---

### Task 2: Brand primitives (Card, CtaButton, SectionTitle, StatusPill, Eyebrow)

**Files:**
- Create: `packages/brand/src/primitives.tsx`
- Modify: `packages/brand/src/index.ts` (export primitives)
- Test: `tests/brand/primitives.test.tsx`

**Interfaces:**
- Produces:
  - `CtaButton({ href, children, variant?: "dark" | "outline" | "text", ... })`
  - `BrandCard({ children, className?, style? })`
  - `SectionTitle({ title, continuation?, light? })`
  - `StatusPill({ tone: "connected" | "pending" | "ready", children })`
  - `Eyebrow({ children })`

- [ ] **Step 1: Write the failing primitive test**

```tsx
// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CtaButton, StatusPill } from "@matrix-os/brand";

describe("@matrix-os/brand primitives", () => {
  it("renders a dark CTA with the deep background", () => {
    render(<CtaButton href="/sign-up">Get started</CtaButton>);
    const link = screen.getByRole("link", { name: /get started/i });
    expect(link.getAttribute("href")).toBe("/sign-up");
    expect(link.getAttribute("style") ?? "").toContain("50, 53, 46");
  });
  it("renders a connected status pill", () => {
    render(<StatusPill tone="connected">Connected</StatusPill>);
    expect(screen.getByText("Connected")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- tests/brand/primitives.test.tsx`
Expected: FAIL — `CtaButton`/`StatusPill` not exported.

- [ ] **Step 3: Implement primitives**

```tsx
// packages/brand/src/primitives.tsx
import type { CSSProperties, ReactNode } from "react";
import { palette as c, cardShadow, fonts, radii } from "./tokens.js";

type CtaVariant = "dark" | "outline" | "text";

const ctaBase: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.5rem",
  borderRadius: radii.control,
  lineHeight: 1,
  fontFamily: fonts.sans,
  fontWeight: 500,
  textDecoration: "none",
  transition: "background 0.3s ease, border-color 0.3s ease, opacity 0.3s ease",
};

const ctaVariants: Record<CtaVariant, CSSProperties> = {
  dark: { backgroundColor: c.deep, border: `1px solid ${c.deep}`, color: "#FAFAF5", padding: "0.75rem 1.125rem" },
  outline: { backgroundColor: "rgba(252,252,248,0.7)", border: `1px solid ${c.border}`, color: c.deep, padding: "0.75rem 1.125rem" },
  text: { background: "transparent", color: c.forest, padding: "0.75rem 0.375rem" },
};

export function CtaButton({
  href,
  children,
  variant = "dark",
  style,
}: {
  href: string;
  children: ReactNode;
  variant?: CtaVariant;
  style?: CSSProperties;
}) {
  return (
    <a href={href} style={{ ...ctaBase, ...ctaVariants[variant], ...style }}>
      {children}
    </a>
  );
}

export function BrandCard({ children, className = "", style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={className} style={{ backgroundColor: c.card, border: `1px solid ${c.border}`, borderRadius: radii.card, boxShadow: cardShadow, ...style }}>
      {children}
    </div>
  );
}

export function SectionTitle({ title, continuation, light = false }: { title: string; continuation?: string; light?: boolean }) {
  return (
    <h2 style={{ fontFamily: fonts.sans, fontSize: "clamp(1.5rem,3vw,2rem)", fontWeight: 500, letterSpacing: "-0.01em", color: light ? "#FAFAF5" : c.deep, margin: 0 }}>
      {title}
      {continuation ? <span style={{ color: light ? "rgba(250,250,245,0.55)" : c.subtle }}> {continuation}</span> : null}
    </h2>
  );
}

const pillTones = {
  connected: { bg: "rgba(67,78,63,0.08)", color: "#3B6D11" },
  ready: { bg: "rgba(67,78,63,0.08)", color: "#3B6D11" },
  pending: { bg: "rgba(208,111,37,0.10)", color: "#993C1D" },
} as const;

export function StatusPill({ tone, children }: { tone: keyof typeof pillTones; children: ReactNode }) {
  const t = pillTones[tone];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", background: t.bg, color: t.color, fontSize: "12px", fontWeight: 500, padding: "5px 11px", borderRadius: radii.pill }}>
      {children}
    </span>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <span style={{ fontFamily: fonts.sans, fontSize: "11px", fontWeight: 600, letterSpacing: "0.18em", textTransform: "uppercase", color: c.subtle }}>
      {children}
    </span>
  );
}
```

Restore the full `index.ts`:

```ts
export * from "./tokens.js";
export * from "./primitives.js";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- tests/brand/primitives.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/brand/src/primitives.tsx packages/brand/src/index.ts tests/brand/primitives.test.tsx
git commit -m "feat(brand): add shared brand primitives"
```

---

### Task 3: Wire www + shell to depend on the package; re-export landing theme

**Files:**
- Modify: `www/package.json` (add dep + pre-build), `shell/package.json` (add dep + pre-build)
- Modify: `www/src/components/landing/theme.ts` (re-export from package)
- Test: `tests/brand/theme-reexport.test.ts`

**Interfaces:**
- Consumes: `@matrix-os/brand`.
- Produces: `www/src/components/landing/theme.ts` continues to export `palette`, `fonts`, `cardShadow`, `cardShadowSmall` (now sourced from the package), so all existing landing imports are unchanged.

- [ ] **Step 1: Write the failing re-export test**

```ts
// tests/brand/theme-reexport.test.ts
import { describe, expect, it } from "vitest";
import { palette as brandPalette } from "@matrix-os/brand";
import { palette as landingPalette, cardShadow } from "../../www/src/components/landing/theme";

describe("landing theme re-exports the brand package", () => {
  it("keeps the same palette object values", () => {
    expect(landingPalette.forest).toBe(brandPalette.forest);
    expect(landingPalette.ember).toBe(brandPalette.ember);
  });
  it("keeps cardShadow", () => {
    expect(cardShadow).toBe("0 0 7.5rem 0 rgba(50, 53, 46, 0.09)");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- tests/brand/theme-reexport.test.ts`
Expected: FAIL — landing `theme.ts` still defines its own literals (values match but the import path/source differs; this test passes only once theme.ts re-exports). Confirm by temporarily asserting referential equality if needed.

- [ ] **Step 3: Add the dependency + pre-build to www and shell**

In `www/package.json` dependencies add: `"@matrix-os/brand": "workspace:*",`
In `www/package.json` `build` script, extend the pre-build filter:
`"build": "pnpm --dir .. --filter '@matrix-os/observability' --filter '@matrix-os/brand' build && next build",`

Mirror both in `shell/package.json` (dependency + `--filter '@matrix-os/brand'` in its `build`).

- [ ] **Step 4: Re-export the landing theme from the package**

```ts
// www/src/components/landing/theme.ts
export { palette, fonts, cardShadow, cardShadowSmall } from "@matrix-os/brand";
```

- [ ] **Step 5: Install + run the test to verify it passes**

Run: `pnpm install` (from repo root, links the workspace package)
Run: `bun run test -- tests/brand/theme-reexport.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add www/package.json shell/package.json www/src/components/landing/theme.ts pnpm-lock.yaml tests/brand/theme-reexport.test.ts
git commit -m "feat(brand): consume @matrix-os/brand from www landing theme"
```

---

### Task 4: Unify `onboarding-brand.ts` onto canonical tokens

**Files:**
- Modify: `shell/src/lib/onboarding-brand.ts`
- Test: `tests/shell/onboarding-brand-unified.test.ts`

**Interfaces:**
- `matrixOnboardingPalette` keeps the same property names but its forest/ember/etc. now equal the canonical brand values. (These screens are removed in Slice 3; this only converges colors so nothing renders the off-brand `#17281f`/`#d6653b` in the interim.)

- [ ] **Step 1: Write the failing test**

```ts
// tests/shell/onboarding-brand-unified.test.ts
import { describe, expect, it } from "vitest";
import { palette } from "@matrix-os/brand";
import { matrixOnboardingPalette } from "../../shell/src/lib/onboarding-brand";

describe("onboarding-brand is unified with the canonical palette", () => {
  it("uses the canonical forest and ember", () => {
    expect(matrixOnboardingPalette.forest).toBe(palette.forest);
    expect(matrixOnboardingPalette.ember).toBe(palette.ember);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- tests/shell/onboarding-brand-unified.test.ts`
Expected: FAIL — forest is `#17281f`, not `#434E3F`.

- [ ] **Step 3: Redefine the palette via the package**

In `shell/src/lib/onboarding-brand.ts`, import canonical tokens and map the existing keys onto them (keep any keys consumers still read, e.g. `stone`, `sage`, `pebble`, mapping to nearest canonical token or keeping neutral creams):

```ts
import { palette as brand } from "@matrix-os/brand";

export const matrixOnboardingPalette = {
  stone: brand.cream,
  sage: brand.forest,
  forest: brand.forest,
  ember: brand.ember,
  ink: brand.deep,
  lichen: brand.cream,
  pebble: brand.card,
} as const;
```

Remove the unused `Orbitron` brand font entry if present (keep body/technical font references).

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- tests/shell/onboarding-brand-unified.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shell/src/lib/onboarding-brand.ts tests/shell/onboarding-brand-unified.test.ts
git commit -m "refactor(shell): unify onboarding-brand onto @matrix-os/brand"
```

---

### Task 5: Verification

- [ ] **Step 1: Build the package + dependents**

Run: `pnpm --filter '@matrix-os/brand' build`
Expected: emits `packages/brand/dist/*.js` + `.d.ts`, no errors.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no errors in `packages/brand`, `www`, `shell`.

- [ ] **Step 3: Pattern scan + targeted tests**

Run: `bun run check:patterns` then `bun run test -- tests/brand tests/shell/onboarding-brand-unified.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit any lockfile/build adjustments**

```bash
git add -A specs/099-onboarding-journey
git commit -m "docs(099): brand foundation slice complete"
```

## Self-Review

- **Spec coverage:** Parent §"Brand source of truth" → Tasks 1–4 (tokens, primitives, re-export, unify). Slice dependency note (unblocks 2+3) satisfied by the package + alias.
- **Placeholders:** none — full code in every step. The Task 1 Step 4 note about temporarily narrowing `index.ts` is an explicit sequencing instruction, resolved in Task 2.
- **Type consistency:** `palette`/`fonts`/`cardShadow` names identical across package, landing re-export, and tests. `CtaButton` variant union (`dark|outline|text`) is the same set referenced by Slice 2/3 plans.
