# Slice 2 — Auth redesign + clickable billing + preselect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign sign-up (Direction A "product visual") and sign-in (Direction C "editorial + roster") onto `@matrix-os/brand`, make landing pricing rows clickable, and preselect the chosen plan via Clerk public metadata — without bypassing the onboarding state machine.

**Architecture:** Auth visuals consume the Slice 1 brand package. The billing/preselect logic is adopted verbatim from `specs/098-onboarding-billing-preselect/plan.md` (it is independent of the brand package). This slice supersedes that plan's auth-visual tasks (6–7) with the A/C directions.

**Tech Stack:** Next.js 16 (async server components + route handlers), React 19, Clerk, `@matrix-os/brand`, Vitest (node source-text for `tests/www`, jsdom+RTL for `tests/shell`).

## Global Constraints

- Depends on **Slice 1** (`@matrix-os/brand` available + `tests/www`/`tests/shell` can import it).
- Branch: active onboarding branch / manual worktree. Never commit to `main`.
- Sign-up left = Direction A; sign-in left = Direction C. Both consume brand tokens — no hardcoded hex.
- Preselect is UI-only; post-signup lands on app **root** (state machine decides phase).
- `/welcome` authenticated; plan validated against allowlist; write failure logged + non-blocking.
- Landing labels/prices locked to `MATRIX_BILLING_SERVER_PROFILES` via parity test.
- React changes → `npx react-doctor@latest www`. Screenshot evidence for sign-up, sign-in, clickable pricing.

---

## Adopted tasks (from spec 098, unchanged)

Implement these **exactly as written** in `specs/098-onboarding-billing-preselect/plan.md` — they are independent of the brand package:

- [ ] **Adopt Task 1** — `www/src/lib/billing-plans.ts` + `tests/www/landing-billing-parity.test.ts` (canonical plan data + Stripe parity guard).
- [ ] **Adopt Task 2** — clickable landing pricing rows in `LandingBilling.tsx` + `tests/www/landing-billing-clickable.test.ts`.
- [ ] **Adopt Task 3** — sign-up reads `?plan` and routes through `/welcome` + `tests/www/auth-routing.test.ts` update.
- [ ] **Adopt Task 4** — `www/src/app/welcome/route.ts` writes `publicMetadata.selectedPlan` + `tests/www/welcome-route.test.ts`.
- [ ] **Adopt Task 5** — `BillingPanel` preselect from `publicMetadata` + `tests/shell/billing-panel-preselect.test.tsx`.

> Do NOT implement spec 098 Tasks 6–7 (the editorial-proof-list auth redesign). They are superseded by Tasks A1–A3 below (Directions A/C on the brand package).

---

### Task A1: FeatureShowcase — variant-driven (product / roster)

**Files:**
- Modify (replace): `www/src/components/auth/FeatureShowcase.tsx`
- Test: `tests/www/auth-feature-showcase.test.ts`

**Interfaces:**
- Consumes: `palette`, `fonts` from `@matrix-os/brand`.
- Produces: `FeatureShowcase({ heading?, subheading?, variant?: "product" | "roster" })`. Default `variant="product"`.

- [ ] **Step 1: Write the failing source-text test**

```ts
// tests/www/auth-feature-showcase.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(join(process.cwd(), "www/src/components/auth/FeatureShowcase.tsx"), "utf8");

describe("auth FeatureShowcase", () => {
  it("consumes the brand package, not landing theme literals", () => {
    expect(src).toContain('from "@matrix-os/brand"');
  });
  it("supports product and roster variants", () => {
    expect(src).toContain('variant');
    expect(src).toContain('"product"');
    expect(src).toContain('"roster"');
  });
  it("drops the rotating carousel machinery", () => {
    expect(src).not.toContain("setInterval");
    expect(src).not.toContain("authProgressFill");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- tests/www/auth-feature-showcase.test.ts`
Expected: FAIL.

- [ ] **Step 3: Replace the component**

```tsx
// www/src/components/auth/FeatureShowcase.tsx
import { palette as c, fonts } from "@matrix-os/brand";

interface FeatureShowcaseProps {
  heading?: string;
  subheading?: string;
  variant?: "product" | "roster";
}

const AGENTS = ["Claude", "Codex", "Cursor", "Hermes"] as const;

function Wordmark() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 20 }}>
      <span style={{ width: 30, height: 30, borderRadius: 8, background: c.card, border: `1px solid ${c.border}`, display: "inline-flex", alignItems: "center", justifyContent: "center", color: c.forest, fontSize: 15 }} aria-hidden="true">◩</span>
      <span style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 500, color: c.forest }}>matrix-os</span>
    </div>
  );
}

export function FeatureShowcase({
  heading = "A computer in the cloud for your AI agents",
  subheading = "Run Claude, Codex, and Hermes as background agents that keep going after your laptop closes.",
  variant = "product",
}: FeatureShowcaseProps) {
  return (
    <div style={{ fontFamily: fonts.sans }}>
      <Wordmark />
      <h1 style={{ fontFamily: fonts.display, fontWeight: 400, color: c.deep, lineHeight: 1.02, fontSize: variant === "roster" ? "clamp(2.6rem,5vw,3.4rem)" : "clamp(2.1rem,4vw,2.7rem)", maxWidth: "13ch", margin: 0 }}>
        {heading}
      </h1>
      <p style={{ color: c.mutedFg, fontSize: 14, lineHeight: 1.55, marginTop: 12, maxWidth: "40ch" }}>{subheading}</p>

      {variant === "product" ? (
        <div style={{ marginTop: 18, borderRadius: 12, overflow: "hidden", border: `1px solid ${c.border}`, background: c.card, boxShadow: "0 20px 50px rgba(50,53,46,0.10)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "7px 10px", background: "#F1EFE7", borderBottom: `1px solid ${c.border}` }}>
            {[0, 1, 2].map((i) => <span key={i} style={{ width: 7, height: 7, borderRadius: "50%", background: c.border }} />)}
            <span style={{ marginLeft: 8, fontFamily: "var(--font-mono, monospace)", fontSize: 10, color: c.subtle }}>workspace</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, background: c.border }}>
            <div style={{ background: c.forestDeep, padding: 11, minHeight: 96, fontFamily: "var(--font-mono, monospace)", fontSize: 10, lineHeight: 1.7 }}>
              <p style={{ color: "#9FB39A", margin: 0 }}>$ claude build tracker</p>
              <p style={{ color: c.cream, margin: 0 }}>› writing ~/apps/app.tsx</p>
              <p style={{ color: "#C0DD97", margin: 0 }}>✓ done in 4.2s</p>
            </div>
            <div style={{ background: c.card, padding: 11 }}>
              <p style={{ fontSize: 10, fontWeight: 600, color: c.subtle, textTransform: "uppercase", letterSpacing: "0.1em", margin: 0 }}>Agents</p>
              <div style={{ marginTop: 7, display: "flex", flexDirection: "column", gap: 6, fontSize: 11, color: c.deep }}>
                <span>● Claude · running</span><span>● Codex · PR opened</span><span style={{ color: c.subtle }}>○ Hermes · idle</span>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 20, borderTop: `1px solid ${c.border}`, paddingTop: 16 }}>
          <p style={{ fontSize: 10, fontWeight: 600, color: c.subtle, textTransform: "uppercase", letterSpacing: "0.16em", margin: "0 0 11px" }}>Runs your agents</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
            {AGENTS.map((a) => (
              <span key={a} style={{ fontSize: 12, color: c.deep, background: c.card, border: `1px solid ${c.border}`, padding: "6px 11px", borderRadius: 999 }}>{a}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- tests/www/auth-feature-showcase.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add www/src/components/auth/FeatureShowcase.tsx tests/www/auth-feature-showcase.test.ts
git commit -m "feat(www): variant-driven auth showcase on the brand kit"
```

---

### Task A2: AuthLayout on the brand card surface

**Files:**
- Modify (replace): `www/src/components/auth/AuthLayout.tsx`
- Modify: `www/src/components/auth/clerkAppearance.ts` (radius polish)
- Test: `tests/www/auth-layout.test.ts`

**Interfaces:**
- Consumes: `palette`, `cardShadow` from `@matrix-os/brand`.
- Produces: `AuthLayout({ featureContent, formContent })` — cream page + brand form card.

- [ ] **Step 1: Write the failing source-text test**

```ts
// tests/www/auth-layout.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const src = readFileSync(join(process.cwd(), "www/src/components/auth/AuthLayout.tsx"), "utf8");
describe("AuthLayout", () => {
  it("uses the brand package", () => { expect(src).toContain('from "@matrix-os/brand"'); });
  it("drops the gradient + grid overlay", () => {
    expect(src).not.toContain("linear-gradient(115deg");
    expect(src).not.toContain("56px 56px");
  });
  it("keeps the two-slot API", () => { expect(src).toContain("featureContent"); expect(src).toContain("formContent"); });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- tests/www/auth-layout.test.ts`
Expected: FAIL.

- [ ] **Step 3: Replace `AuthLayout.tsx`**

```tsx
"use client";

import type { ReactNode } from "react";
import { palette as c, cardShadow } from "@matrix-os/brand";

interface AuthLayoutProps {
  featureContent: ReactNode;
  formContent: ReactNode;
}

export function AuthLayout({ featureContent, formContent }: AuthLayoutProps) {
  return (
    <main className="relative min-h-screen overflow-hidden" style={{ backgroundColor: c.pageBg, color: c.deep }}>
      <div className="relative mx-auto grid min-h-screen w-full max-w-6xl items-center gap-8 px-5 py-10 lg:grid-cols-[minmax(0,1fr)_minmax(380px,430px)] lg:gap-20 lg:px-10 xl:px-0">
        <div className="min-w-0 border-b pb-8 lg:border-b-0 lg:pb-0" style={{ borderColor: c.border }}>
          {featureContent}
        </div>
        <aside className="relative mx-auto w-full max-w-[430px] lg:justify-self-end">
          <div className="mb-4 flex items-center justify-between border-b pb-3 text-xs font-semibold uppercase tracking-[0.18em]" style={{ borderColor: c.border, color: c.subtle }}>
            <span>Matrix account</span><span>Secure session</span>
          </div>
          <div className="relative overflow-hidden rounded-2xl p-4" style={{ backgroundColor: c.card, border: `1px solid ${c.border}`, boxShadow: cardShadow }}>
            {formContent}
          </div>
        </aside>
      </div>
    </main>
  );
}
```

- [ ] **Step 4: Polish `clerkAppearance.ts`** — soften the primary button weight to match the brand card:

```ts
    formButtonPrimary: "!h-11 !rounded-xl !font-medium",
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test -- tests/www/auth-layout.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add www/src/components/auth/AuthLayout.tsx www/src/components/auth/clerkAppearance.ts tests/www/auth-layout.test.ts
git commit -m "feat(www): AuthLayout on the brand card surface"
```

---

### Task A3: Wire sign-up (A) and sign-in (C) variants

**Files:**
- Modify: `www/src/app/sign-up/[[...sign-up]]/page.tsx` (already edited in adopted Task 3 — set `variant="product"`)
- Modify: `www/src/app/sign-in/[[...sign-in]]/page.tsx` (set `variant="roster"`)
- Test: `tests/www/auth-variants.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/www/auth-variants.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
describe("auth screen variants", () => {
  it("sign-up uses the product visual", () => {
    expect(read("www/src/app/sign-up/[[...sign-up]]/page.tsx")).toContain('variant="product"');
  });
  it("sign-in uses the roster", () => {
    expect(read("www/src/app/sign-in/[[...sign-in]]/page.tsx")).toContain('variant="roster"');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- tests/www/auth-variants.test.ts`
Expected: FAIL.

- [ ] **Step 3: Set the variants + headings**

In sign-up `page.tsx`, the `<FeatureShowcase>` gets `variant="product"` with the sign-up heading. In sign-in `page.tsx`:

```tsx
        featureContent={
          <FeatureShowcase
            variant="roster"
            heading="A computer in the cloud for your AI agents"
            subheading="Welcome back. Your machine and agents are right where you left them."
          />
        }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- tests/www/auth-variants.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add "www/src/app/sign-up/[[...sign-up]]/page.tsx" "www/src/app/sign-in/[[...sign-in]]/page.tsx" tests/www/auth-variants.test.ts
git commit -m "feat(www): sign-up product visual, sign-in roster"
```

---

### Task A4: Verification

- [ ] **Step 1: Full touched-area suite**

Run: `bun run test -- tests/www tests/shell/billing-panel-preselect.test.tsx`
Expected: PASS (new + adopted specs + existing `auth-routing`).

- [ ] **Step 2: Typecheck + patterns**

Run: `bun run typecheck && bun run check:patterns`
Expected: clean.

- [ ] **Step 3: React audit**

Run: `npx react-doctor@latest www`
Expected: resolve findings on changed files.

- [ ] **Step 4: Screenshots**

With landing dev (`cd www && pnpm dev`, `:3001`) capture `/sign-up` (product visual), `/sign-in` (roster), landing `#pricing` row hover. Save under `specs/099-onboarding-journey/`.

- [ ] **Step 5: Commit evidence**

```bash
git add specs/099-onboarding-journey
git commit -m "docs(099): auth + billing slice verification evidence"
```

## Self-Review

- **Spec coverage:** Parent screens 1 (sign-up A), 2 (sign-in C), 3 (billing parity+preselect adopted), all mapped. Brand-package consumption enforced by source-text tests.
- **Placeholders:** none. Adopted tasks point to the complete spec-098 plan; new auth tasks carry full code.
- **Type consistency:** `FeatureShowcase` `variant` union (`product|roster`) matches the wiring in Task A3; `palette`/`fonts`/`cardShadow` names match the Slice 1 package exports.
