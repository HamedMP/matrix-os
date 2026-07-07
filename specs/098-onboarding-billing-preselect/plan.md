# Onboarding Polish — Auth Redesign + Clickable Billing Preselect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the sign-in/sign-up left side up to landing-page visual quality, make landing pricing rows clickable, and preselect the chosen plan later in onboarding via Clerk public metadata — without bypassing the onboarding state machine.

**Architecture:** All net-new logic lives in `www` (a canonical plan-data module, a `/welcome` server route that writes `publicMetadata.selectedPlan`, sign-up wiring). The shell only *reads* that metadata to default the existing billing picker. Plan labels/prices are locked to the shell's Stripe source of truth (`MATRIX_BILLING_SERVER_PROFILES`) by a cross-package parity test. Preselect is UI intent only; `deriveJourneyPhase` and checkout are untouched.

**Tech Stack:** Next.js 16 (App Router, async server components + route handlers), React 19, Clerk (`@clerk/nextjs` + `@clerk/nextjs/server`), Vitest (node for source/logic tests, jsdom+RTL for shell component tests), Tailwind tokens + `www/src/components/landing/theme.ts` palette/fonts.

## Global Constraints

- Branch: continue on **`fix/www-onboarding-flow`** (the active onboarding branch). Never commit to `main`.
- No hardcoded hex where a landing token exists — import `palette`/`fonts`/`cardShadow` from `www/src/components/landing/theme.ts` for auth visuals.
- Validate `plan` against an allowlist (`parsePlanUrlSlug`) before any use in metadata or URLs. No raw value reaches `updateUserMetadata`.
- `/welcome` must be authenticated (`auth()` userId). Anonymous → redirect, never write.
- No raw provider errors to the client; log server-side, redirect with a generic outcome.
- Metadata write failure must never block onboarding — catch, log, still redirect.
- Preselect never advances/skips a journey phase. Post-signup lands on app **root** (normal boot sequence).
- Landing plan labels/prices/specs must equal `MATRIX_BILLING_SERVER_PROFILES` — enforced by parity test (CI gate).
- React changes (`.tsx`) → run `npx react-doctor@latest www` and `npx react-doctor@latest shell` before commit; resolve findings.
- Frontend-visible changes → capture screenshots (sign-in, sign-up, clickable pricing).
- vitest alias: `@` → `shell/src`. Import www modules in tests by relative path (`../../www/src/...`).

---

### Task 1: Canonical www plan-data module + Stripe parity guard

**Files:**
- Create: `www/src/lib/billing-plans.ts`
- Test: `tests/www/landing-billing-parity.test.ts`

**Interfaces:**
- Produces:
  - `type PlanUrlSlug = "starter" | "builder" | "max"`
  - `type PlanSlug = "matrix_starter" | "matrix_builder" | "matrix_max"`
  - `interface LandingPlan { urlSlug: PlanUrlSlug; planSlug: PlanSlug; featureSlug: "server_cpx22" | "server_cpx32" | "server_cpx52"; label: string; machine: string; vcpus: number; memoryGb: number; diskGb: number; monthly: string; annual: string; popular: boolean }`
  - `const LANDING_PLANS: LandingPlan[]`
  - `function parsePlanUrlSlug(value: string | null | undefined): PlanSlug | null`
  - `function planSlugToFeatureSlug(planSlug: string): string | null`

- [ ] **Step 1: Write the failing parity test**

```ts
// tests/www/landing-billing-parity.test.ts
import { describe, expect, it } from "vitest";
import { MATRIX_BILLING_SERVER_PROFILES } from "@/lib/billing"; // @ -> shell/src
import {
  LANDING_PLANS,
  parsePlanUrlSlug,
  planSlugToFeatureSlug,
} from "../../www/src/lib/billing-plans";

describe("landing plan data parity with Stripe billing select", () => {
  it("matches every shell billing profile by planSlug", () => {
    for (const profile of MATRIX_BILLING_SERVER_PROFILES) {
      const plan = LANDING_PLANS.find((p) => p.planSlug === profile.planSlug);
      expect(plan, `missing landing plan for ${profile.planSlug}`).toBeTruthy();
      if (!plan) continue;
      expect(plan.label).toBe(profile.label);
      expect(plan.featureSlug).toBe(profile.featureSlug);
      expect(plan.machine).toBe(profile.hetznerType);
      expect(plan.vcpus).toBe(profile.vcpus);
      expect(plan.memoryGb).toBe(profile.memoryGb);
      expect(plan.diskGb).toBe(profile.diskGb);
      expect(plan.monthly).toBe(`$${profile.monthlyPriceUsd}`);
      expect(plan.annual).toBe(`$${profile.annualPriceUsd}`);
    }
  });

  it("covers exactly the shell profiles (no extra/stale landing plans)", () => {
    expect(LANDING_PLANS.length).toBe(MATRIX_BILLING_SERVER_PROFILES.length);
  });

  it("validates plan url slugs against the allowlist", () => {
    expect(parsePlanUrlSlug("builder")).toBe("matrix_builder");
    expect(parsePlanUrlSlug("BUILDER")).toBe("matrix_builder");
    expect(parsePlanUrlSlug("enterprise")).toBeNull();
    expect(parsePlanUrlSlug(undefined)).toBeNull();
    expect(parsePlanUrlSlug(null)).toBeNull();
  });

  it("maps plan slug to the shell feature slug", () => {
    expect(planSlugToFeatureSlug("matrix_builder")).toBe("server_cpx32");
    expect(planSlugToFeatureSlug("nope")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- tests/www/landing-billing-parity.test.ts`
Expected: FAIL — cannot resolve `../../www/src/lib/billing-plans`.

- [ ] **Step 3: Create the module**

```ts
// www/src/lib/billing-plans.ts
// Canonical landing plan data. MUST stay in sync with the shell billing select
// (MATRIX_BILLING_SERVER_PROFILES) — enforced by tests/www/landing-billing-parity.test.ts.

export type PlanUrlSlug = "starter" | "builder" | "max";
export type PlanSlug = "matrix_starter" | "matrix_builder" | "matrix_max";
export type FeatureSlug = "server_cpx22" | "server_cpx32" | "server_cpx52";

export interface LandingPlan {
  urlSlug: PlanUrlSlug;
  planSlug: PlanSlug;
  featureSlug: FeatureSlug;
  label: string;
  machine: string;
  vcpus: number;
  memoryGb: number;
  diskGb: number;
  monthly: string;
  annual: string;
  popular: boolean;
}

export const LANDING_PLANS: LandingPlan[] = [
  {
    urlSlug: "starter",
    planSlug: "matrix_starter",
    featureSlug: "server_cpx22",
    label: "Starter",
    machine: "CPX22",
    vcpus: 2,
    memoryGb: 4,
    diskGb: 80,
    monthly: "$14",
    annual: "$140",
    popular: false,
  },
  {
    urlSlug: "builder",
    planSlug: "matrix_builder",
    featureSlug: "server_cpx32",
    label: "Builder",
    machine: "CPX32",
    vcpus: 4,
    memoryGb: 8,
    diskGb: 160,
    monthly: "$19",
    annual: "$190",
    popular: true,
  },
  {
    urlSlug: "max",
    planSlug: "matrix_max",
    featureSlug: "server_cpx52",
    label: "Max",
    machine: "CPX52",
    vcpus: 12,
    memoryGb: 24,
    diskGb: 480,
    monthly: "$49",
    annual: "$490",
    popular: false,
  },
];

const URL_SLUG_TO_PLAN: Record<PlanUrlSlug, PlanSlug> = {
  starter: "matrix_starter",
  builder: "matrix_builder",
  max: "matrix_max",
};

export function parsePlanUrlSlug(value: string | null | undefined): PlanSlug | null {
  if (!value) return null;
  const key = value.trim().toLowerCase() as PlanUrlSlug;
  return URL_SLUG_TO_PLAN[key] ?? null;
}

export function planSlugToFeatureSlug(planSlug: string): string | null {
  return LANDING_PLANS.find((p) => p.planSlug === planSlug)?.featureSlug ?? null;
}

export function specLine(plan: LandingPlan): string {
  return `${plan.vcpus} vCPU / ${plan.memoryGb} GB RAM / ${plan.diskGb} GB disk`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- tests/www/landing-billing-parity.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add www/src/lib/billing-plans.ts tests/www/landing-billing-parity.test.ts
git commit -m "feat(www): canonical landing plan data with Stripe parity guard"
```

---

### Task 2: Clickable landing pricing rows

**Files:**
- Modify: `www/src/components/landing/LandingBilling.tsx` (replace inline `plans` array + row markup)
- Test: `tests/www/landing-billing-clickable.test.ts`

**Interfaces:**
- Consumes: `LANDING_PLANS`, `specLine` from `@/lib/billing-plans` (www `@` → `www/src`); `SIGN_UP_HREF` from `./links`.

- [ ] **Step 1: Write the failing source-text test**

```ts
// tests/www/landing-billing-clickable.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  join(process.cwd(), "www/src/components/landing/LandingBilling.tsx"),
  "utf8",
);

describe("landing billing is clickable", () => {
  it("sources plan data from the canonical module", () => {
    expect(src).toContain('from "@/lib/billing-plans"');
    expect(src).toContain("LANDING_PLANS");
  });

  it("links each plan row to sign-up with its url slug", () => {
    expect(src).toContain("/sign-up?plan=${plan.urlSlug}");
  });

  it("emits plan-click telemetry", () => {
    expect(src).toContain("marketing_billing_plan_clicked");
  });

  it("drops the duplicated inline plans array", () => {
    expect(src).not.toContain('machine: "CPX22"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- tests/www/landing-billing-clickable.test.ts`
Expected: FAIL (inline `CPX22` still present, no `/sign-up?plan=`).

- [ ] **Step 3: Edit `LandingBilling.tsx`**

Replace the inline `plans` constant (the `const plans = [...] as const;` block) — delete it. Add to imports:

```tsx
import { LANDING_PLANS, specLine } from "@/lib/billing-plans";
```

Replace the plan-rows block (the `{plans.map((plan, index) => ( ... ))}` inside the bordered container) with clickable anchors:

```tsx
{LANDING_PLANS.map((plan, index) => (
  <a
    key={plan.planSlug}
    href={`/sign-up?plan=${plan.urlSlug}`}
    data-ph-event="marketing_billing_plan_clicked"
    data-ph-location="pricing_section"
    data-ph-target={plan.urlSlug}
    className={`group flex items-center justify-between gap-4 px-5 py-5 transition-colors hover:bg-[rgba(67,78,63,0.05)] ${
      index < LANDING_PLANS.length - 1 ? "border-b" : ""
    }`}
    style={{
      borderColor: c.border,
      backgroundColor: plan.popular ? "rgba(67,78,63,0.04)" : undefined,
    }}
  >
    <div>
      <div className="flex items-center gap-2.5">
        <h3 className="text-[1.0625rem] font-medium" style={{ color: c.deep, fontFamily: fonts.sans }}>
          {plan.label}
        </h3>
        {plan.popular ? (
          <span
            className="rounded-md px-2 py-0.5 text-[0.75rem] font-medium"
            style={{ backgroundColor: c.forestDeep, color: "#F4F2E6" }}
          >
            Popular
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-[0.8125rem]" style={{ color: c.subtle }}>
        {plan.machine} · {specLine(plan)}
      </p>
    </div>
    <div className="flex items-center gap-3 text-right">
      <div>
        <p className="text-[2rem] leading-none" style={{ fontFamily: fonts.display, color: c.forest }}>
          {plan.monthly}
          <span className="ml-1 text-[0.8125rem]" style={{ color: c.subtle, fontFamily: fonts.sans }}>
            /mo
          </span>
        </p>
        <p className="mt-1 text-[0.8125rem]" style={{ color: c.subtle }}>
          {plan.annual}/yr
        </p>
      </div>
      <ArrowRightIcon
        className="size-4 shrink-0 -translate-x-1 opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100"
        style={{ color: c.forest }}
        aria-hidden="true"
      />
    </div>
  </a>
))}
```

Add `ArrowRightIcon` to the existing `lucide-react` import line.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- tests/www/landing-billing-clickable.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add www/src/components/landing/LandingBilling.tsx tests/www/landing-billing-clickable.test.ts
git commit -m "feat(www): make landing pricing rows clickable to sign-up"
```

---

### Task 3: Sign-up reads `?plan` and routes through `/welcome`

**Files:**
- Modify: `www/src/app/sign-up/[[...sign-up]]/page.tsx`
- Modify: `tests/www/auth-routing.test.ts` (the existing assertion now reflects conditional redirect)

**Interfaces:**
- Consumes: `parsePlanUrlSlug` (`@/lib/billing-plans`), `getMarketingAuthRedirectUrl`, `getSignupFallbackRedirectUrl` (`@/inngest/provision-status`).
- Produces: when a valid `?plan` is present, `SignUp.forceRedirectUrl = /welcome?plan=<urlSlug>`; otherwise unchanged.

- [ ] **Step 1: Update the existing auth-routing expectation (failing)**

In `tests/www/auth-routing.test.ts`, replace the `forces completed marketing Clerk flows to the app domain` test body with:

```ts
  it("forces completed marketing Clerk flows to the app domain", () => {
    const signIn = read("www/src/app/sign-in/[[...sign-in]]/page.tsx");
    expect(signIn).toContain("forceRedirectUrl={getMarketingAuthRedirectUrl()}");
  });

  it("routes preselected sign-ups through the metadata handoff", () => {
    const signUp = read("www/src/app/sign-up/[[...sign-up]]/page.tsx");
    expect(signUp).toContain("parsePlanUrlSlug");
    expect(signUp).toContain("/welcome?plan=");
    // falls back to the app domain when no plan is chosen
    expect(signUp).toContain("getMarketingAuthRedirectUrl()");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- tests/www/auth-routing.test.ts`
Expected: FAIL — sign-up page lacks `parsePlanUrlSlug` / `/welcome?plan=`.

- [ ] **Step 3: Edit the sign-up page**

```tsx
// www/src/app/sign-up/[[...sign-up]]/page.tsx
import type { Metadata } from "next";
import { SignUp } from "@clerk/nextjs";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { PostHogIdentify } from "@/components/PostHogIdentify";
import { FeatureShowcase } from "@/components/auth/FeatureShowcase";
import { matrixClerkAppearance } from "@/components/auth/clerkAppearance";
import { parsePlanUrlSlug } from "@/lib/billing-plans";
import {
  getMarketingAuthRedirectUrl,
  getSignupFallbackRedirectUrl,
} from "@/inngest/provision-status";

export const metadata: Metadata = {
  title: "Sign up",
  description: "Create your Matrix OS account to get started with your cloud computer.",
};

const URL_PLAN_SLUG: Record<string, string> = {
  matrix_starter: "starter",
  matrix_builder: "builder",
  matrix_max: "max",
};

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawPlan = Array.isArray(params.plan) ? params.plan[0] : params.plan;
  const planSlug = parsePlanUrlSlug(rawPlan);
  // Valid plan → hand off through /welcome so we can persist the choice to
  // Clerk public metadata before the app's onboarding state machine takes over.
  const redirectUrl = planSlug
    ? `/welcome?plan=${URL_PLAN_SLUG[planSlug]}`
    : getMarketingAuthRedirectUrl();

  return (
    <>
      <AuthLayout
        featureContent={
          <FeatureShowcase
            heading="Start with a free account"
            subheading="Create your Matrix identity first. The 3-day hosted trial starts only when you provision a cloud computer."
          />
        }
        formContent={
          <SignUp
            forceRedirectUrl={redirectUrl}
            fallbackRedirectUrl={planSlug ? redirectUrl : getSignupFallbackRedirectUrl()}
            appearance={matrixClerkAppearance}
          />
        }
      />
      <PostHogIdentify />
    </>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- tests/www/auth-routing.test.ts`
Expected: PASS (all tests in file).

- [ ] **Step 5: Commit**

```bash
git add "www/src/app/sign-up/[[...sign-up]]/page.tsx" tests/www/auth-routing.test.ts
git commit -m "feat(www): carry preselected plan from sign-up into metadata handoff"
```

---

### Task 4: `/welcome` route writes `publicMetadata.selectedPlan`

**Files:**
- Create: `www/src/app/welcome/route.ts`
- Test: `tests/www/welcome-route.test.ts`

**Interfaces:**
- Consumes: `auth`, `clerkClient` from `@clerk/nextjs/server`; `parsePlanUrlSlug` (`@/lib/billing-plans`); `getMarketingAuthRedirectUrl` (`@/inngest/provision-status`).
- Produces: `GET(req: Request): Promise<Response>` — writes metadata for valid plan + authed user, always redirects to the app root.

- [ ] **Step 1: Write the failing test (mock Clerk server)**

```ts
// tests/www/welcome-route.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clerk = vi.hoisted(() => ({
  userId: "user_123" as string | null,
  updateUserMetadata: vi.fn(async () => ({})),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: clerk.userId }),
  clerkClient: async () => ({ users: { updateUserMetadata: clerk.updateUserMetadata } }),
}));

async function loadRoute() {
  vi.resetModules();
  return await import("../../www/src/app/welcome/route");
}

describe("/welcome metadata handoff", () => {
  beforeEach(() => {
    clerk.userId = "user_123";
    clerk.updateUserMetadata.mockClear();
    clerk.updateUserMetadata.mockResolvedValue({});
    process.env.NEXT_PUBLIC_MATRIX_APP_URL = "https://app.matrix-os.com";
  });
  afterEach(() => vi.restoreAllMocks());

  it("writes the selected plan to public metadata and redirects to the app root", async () => {
    const { GET } = await loadRoute();
    const res = await GET(new Request("https://matrix-os.com/welcome?plan=builder"));
    expect(clerk.updateUserMetadata).toHaveBeenCalledWith("user_123", {
      publicMetadata: { selectedPlan: "matrix_builder" },
    });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://app.matrix-os.com");
  });

  it("ignores an invalid plan but still redirects", async () => {
    const { GET } = await loadRoute();
    const res = await GET(new Request("https://matrix-os.com/welcome?plan=enterprise"));
    expect(clerk.updateUserMetadata).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBe("https://app.matrix-os.com");
  });

  it("does not write metadata for an anonymous request", async () => {
    clerk.userId = null;
    const { GET } = await loadRoute();
    const res = await GET(new Request("https://matrix-os.com/welcome?plan=builder"));
    expect(clerk.updateUserMetadata).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBe("https://app.matrix-os.com");
  });

  it("redirects even when the metadata write throws", async () => {
    clerk.updateUserMetadata.mockRejectedValueOnce(new Error("clerk down"));
    const { GET } = await loadRoute();
    const res = await GET(new Request("https://matrix-os.com/welcome?plan=builder"));
    expect(res.headers.get("location")).toBe("https://app.matrix-os.com");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- tests/www/welcome-route.test.ts`
Expected: FAIL — cannot resolve `../../www/src/app/welcome/route`.

- [ ] **Step 3: Create the route handler**

```ts
// www/src/app/welcome/route.ts
import { NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { parsePlanUrlSlug } from "@/lib/billing-plans";
import { getMarketingAuthRedirectUrl } from "@/inngest/provision-status";

// Persists a marketing-chosen plan to Clerk public metadata, then hands off to
// the app root. The onboarding state machine (deriveJourneyPhase) decides the
// phase from there — this route only records UI intent and never advances it.
export async function GET(req: Request): Promise<Response> {
  const appUrl = getMarketingAuthRedirectUrl();
  const planSlug = parsePlanUrlSlug(new URL(req.url).searchParams.get("plan"));

  if (planSlug) {
    try {
      const { userId } = await auth();
      if (userId) {
        const client = await clerkClient();
        await client.users.updateUserMetadata(userId, {
          publicMetadata: { selectedPlan: planSlug },
        });
      }
    } catch (err: unknown) {
      // Never block onboarding on a metadata write; the picker still has a
      // sensible default. Log a name only — no provider/PII leak.
      console.error(
        "[welcome] selectedPlan metadata write failed:",
        err instanceof Error ? err.name : typeof err,
      );
    }
  }

  return NextResponse.redirect(appUrl);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- tests/www/welcome-route.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add www/src/app/welcome/route.ts tests/www/welcome-route.test.ts
git commit -m "feat(www): /welcome route persists selected plan to public metadata"
```

---

### Task 5: Shell billing picker preselects from `publicMetadata`

**Files:**
- Modify: `shell/src/components/settings/sections/BillingPanel.tsx` (the `selectedProfileSlug` initializer, ~line 914; add a `useUser`-derived default)
- Test: `tests/shell/billing-panel-preselect.test.tsx`

**Interfaces:**
- Consumes: `useUser` from `@clerk/nextjs`; `MATRIX_BILLING_SERVER_PROFILES` (`@/lib/billing`).
- Behavior: initial `selectedProfileSlug` = featureSlug matching `user.publicMetadata.selectedPlan`, else current Builder default (`MATRIX_BILLING_SERVER_PROFILES[1]`).

- [ ] **Step 1: Confirm the exact component + export under test**

Run: `grep -n "export function\|export default\|selectedProfileSlug\|ProfileOptionRows\|aria-pressed" shell/src/components/settings/sections/BillingPanel.tsx | head`
Note the exported component name that owns `selectedProfileSlug` state (the panel rendered inside `BillingSection`). Use that name in the test's render. If it is not directly exported, render via `BillingSection` (as `tests/shell/billing-section.test.tsx` does) and assert on the profile rows.

- [ ] **Step 2: Write the failing preselect test**

```tsx
// @vitest-environment jsdom
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clerk = vi.hoisted(() => ({
  publicMetadata: {} as Record<string, unknown>,
}));

function installClerkMock() {
  vi.doMock("@clerk/nextjs", () => ({
    useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "user_123", has: () => false }),
    useUser: () => ({
      isLoaded: true,
      isSignedIn: true,
      user: { publicMetadata: clerk.publicMetadata },
    }),
  }));
}

async function loadPanel() {
  vi.resetModules();
  installClerkMock();
  // Adjust the named export to the one confirmed in Step 1.
  return await import("../../shell/src/components/settings/sections/BillingPanel.js");
}

describe("BillingPanel plan preselect", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    clerk.publicMetadata = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ access: { runtimeProxyAllowed: false } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("preselects the plan from public metadata", async () => {
    clerk.publicMetadata = { selectedPlan: "matrix_max" };
    const mod = await loadPanel();
    const Panel = mod.BillingPanel ?? mod.MatrixPricingPanel ?? mod.default;
    render(<Panel mode="device-setup" />);
    await waitFor(() => {
      const maxRow = screen.getByRole("button", { name: /Max/i });
      expect(maxRow.getAttribute("aria-pressed")).toBe("true");
    });
  });

  it("falls back to Builder when metadata is absent", async () => {
    clerk.publicMetadata = {};
    const mod = await loadPanel();
    const Panel = mod.BillingPanel ?? mod.MatrixPricingPanel ?? mod.default;
    render(<Panel mode="device-setup" />);
    await waitFor(() => {
      const builderRow = screen.getByRole("button", { name: /Builder/i });
      expect(builderRow.getAttribute("aria-pressed")).toBe("true");
    });
  });
});
```

> If `BillingPanel` requires props beyond `mode`, mirror the prop shape used by `tests/shell/billing-section.test.tsx` (render via `BillingSection` instead). Keep both assertions: metadata-present → that plan; absent → Builder.

- [ ] **Step 3: Run test to verify it fails**

Run: `bun run test -- tests/shell/billing-panel-preselect.test.tsx`
Expected: FAIL — Max not preselected (initializer still hardcodes Builder).

- [ ] **Step 4: Implement the preselect default**

Add the import (alongside the existing `@clerk/nextjs` usage in the file):

```tsx
import { useUser } from "@clerk/nextjs";
```

Add a helper near the other module-level helpers:

```tsx
function preselectedFeatureSlug(selectedPlan: unknown): string | null {
  if (typeof selectedPlan !== "string") return null;
  return (
    MATRIX_BILLING_SERVER_PROFILES.find((p) => p.planSlug === selectedPlan)?.featureSlug ?? null
  );
}
```

In the component that owns `selectedProfileSlug`, read the user and use it as the initial value:

```tsx
  const { user } = useUser();
  const [selectedProfileSlug, setSelectedProfileSlug] = useState<string>(
    () =>
      preselectedFeatureSlug(user?.publicMetadata?.selectedPlan) ??
      MATRIX_BILLING_SERVER_PROFILES[1]?.featureSlug ??
      MATRIX_BILLING_SERVER_PROFILES[0]?.featureSlug ??
      "",
  );
```

(Replace the existing `useState<string>( MATRIX_BILLING_SERVER_PROFILES[1]?.featureSlug ?? ... )` initializer; keep the lazy-init function form so the metadata is read once on mount.)

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run test -- tests/shell/billing-panel-preselect.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6: Guard the existing billing suite**

Run: `bun run test -- tests/shell/billing-section.test.tsx`
Expected: PASS (no regression from the new `useUser` dependency; if the existing Clerk mock lacks `useUser`, add a minimal `useUser: () => ({ user: { publicMetadata: {} } })` to that file's mock).

- [ ] **Step 7: Commit**

```bash
git add shell/src/components/settings/sections/BillingPanel.tsx tests/shell/billing-panel-preselect.test.tsx tests/shell/billing-section.test.tsx
git commit -m "feat(shell): preselect billing plan from public metadata"
```

---

### Task 6: Auth left side — editorial FeatureShowcase rewrite

**Files:**
- Modify (replace): `www/src/components/auth/FeatureShowcase.tsx`
- Test: `tests/www/auth-feature-showcase.test.ts`

**Interfaces:**
- Consumes: `palette`, `fonts` from `../landing/theme`.
- Produces: `FeatureShowcase({ heading?, subheading? })` — still (no carousel) editorial panel.

- [ ] **Step 1: Write the failing source-text test**

```ts
// tests/www/auth-feature-showcase.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  join(process.cwd(), "www/src/components/auth/FeatureShowcase.tsx"),
  "utf8",
);

describe("auth FeatureShowcase is a calm editorial panel", () => {
  it("uses the landing theme tokens", () => {
    expect(src).toContain('from "../landing/theme"');
    expect(src).toContain("fonts.display");
  });
  it("drops the auto-rotating carousel machinery", () => {
    expect(src).not.toContain("setInterval");
    expect(src).not.toContain("authProgressFill");
    expect(src).not.toContain("useState");
  });
  it("keeps the heading/subheading props", () => {
    expect(src).toContain("heading");
    expect(src).toContain("subheading");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- tests/www/auth-feature-showcase.test.ts`
Expected: FAIL (current file uses `setInterval`/`useState`/`authProgressFill`).

- [ ] **Step 3: Replace the component**

```tsx
// www/src/components/auth/FeatureShowcase.tsx
import Image from "next/image";
import {
  TerminalIcon,
  FolderTreeIcon,
  ShieldIcon,
  type LucideIcon,
} from "lucide-react";
import { palette as c, fonts } from "../landing/theme";

const proofPoints: { icon: LucideIcon; title: string; description: string }[] = [
  {
    icon: TerminalIcon,
    title: "Describe it, it builds it",
    description:
      "Tell the OS what you need in plain language. It writes real software, saved as files you own.",
  },
  {
    icon: FolderTreeIcon,
    title: "Everything is a file",
    description:
      "Apps, config, and your AI's personality live as real files. Back up your OS by copying a folder.",
  },
  {
    icon: ShieldIcon,
    title: "Self-healing, and yours",
    description:
      "Git-backed snapshots mean nothing is lost, and a federated Matrix identity follows you everywhere.",
  },
];

interface FeatureShowcaseProps {
  heading?: string;
  subheading?: string;
}

export function FeatureShowcase({
  heading = "The OS that builds itself",
  subheading = "Sign up to get your personal Matrix OS instance.",
}: FeatureShowcaseProps) {
  return (
    <div className="flex flex-col text-center lg:text-left">
      <div className="mb-8 flex items-center justify-center gap-3 lg:justify-start">
        <Image
          src="/rabbit.svg"
          alt="Matrix OS"
          width={36}
          height={36}
          className="size-9 rounded-lg border p-1.5"
          style={{ borderColor: c.border, backgroundColor: c.card }}
        />
        <span className="text-sm font-medium tracking-tight" style={{ color: c.forest }}>
          matrix-os
        </span>
      </div>

      <h1
        className="text-balance text-[clamp(2.5rem,6vw,4.2rem)] leading-[1.03] tracking-[-0.01em] lg:max-w-[12ch]"
        style={{ color: c.deep, fontFamily: fonts.display, fontWeight: 400 }}
      >
        {heading}
      </h1>
      <p
        className="mx-auto mt-5 max-w-[44ch] text-[1.0625rem] leading-[1.6] lg:mx-0"
        style={{ color: c.mutedFg, fontFamily: fonts.sans }}
      >
        {subheading}
      </p>

      <ul
        className="mt-10 hidden border-y lg:block"
        style={{ borderColor: c.border }}
      >
        {proofPoints.map(({ icon: Icon, title, description }, i) => (
          <li
            key={title}
            className="flex items-start gap-4 py-5"
            style={i > 0 ? { borderTop: `1px solid ${c.border}` } : undefined}
          >
            <span
              className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg"
              style={{ backgroundColor: "rgba(67,78,63,0.07)", color: c.forest }}
            >
              <Icon className="size-4" aria-hidden="true" strokeWidth={1.7} />
            </span>
            <div>
              <h3 className="text-[0.9375rem] font-medium" style={{ color: c.deep, fontFamily: fonts.sans }}>
                {title}
              </h3>
              <p className="mt-1 max-w-[42ch] text-[0.9375rem] leading-[1.55]" style={{ color: c.mutedFg }}>
                {description}
              </p>
            </div>
          </li>
        ))}
      </ul>

      {/* Mobile: compact proof list */}
      <div
        className="mx-auto mt-7 grid w-full max-w-md border-y lg:hidden"
        style={{ borderColor: c.border }}
      >
        {proofPoints.map(({ title }, i) => (
          <div
            key={title}
            className="flex items-center gap-3 py-3 text-sm font-medium"
            style={{ color: c.forest, ...(i > 0 ? { borderTop: `1px solid ${c.border}` } : {}) }}
          >
            <span className="size-1.5 rounded-full" style={{ backgroundColor: c.ember }} aria-hidden="true" />
            {title}
          </div>
        ))}
      </div>
    </div>
  );
}
```

(Note: no `"use client"` needed — this is now a static server component. Remove it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- tests/www/auth-feature-showcase.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add www/src/components/auth/FeatureShowcase.tsx tests/www/auth-feature-showcase.test.ts
git commit -m "feat(www): redesign auth left side as calm editorial panel"
```

---

### Task 7: Auth shell — AuthLayout to landing-grade card

**Files:**
- Modify (replace): `www/src/components/auth/AuthLayout.tsx`
- Modify: `www/src/components/auth/clerkAppearance.ts` (radius polish)
- Test: `tests/www/auth-layout.test.ts`

**Interfaces:**
- Consumes: `palette`, `cardShadow` from `../landing/theme`.
- Produces: `AuthLayout({ featureContent, formContent })` — cream page, landing-grade form card.

- [ ] **Step 1: Write the failing source-text test**

```ts
// tests/www/auth-layout.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  join(process.cwd(), "www/src/components/auth/AuthLayout.tsx"),
  "utf8",
);

describe("AuthLayout matches the landing surface", () => {
  it("uses the landing theme tokens", () => {
    expect(src).toContain('from "../landing/theme"');
    expect(src).toContain("cardShadow");
  });
  it("drops the clashing gradient + grid overlay", () => {
    expect(src).not.toContain("linear-gradient(115deg");
    expect(src).not.toContain("56px 56px");
  });
  it("keeps the two-slot API", () => {
    expect(src).toContain("featureContent");
    expect(src).toContain("formContent");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- tests/www/auth-layout.test.ts`
Expected: FAIL (gradient + grid still present).

- [ ] **Step 3: Replace `AuthLayout.tsx`**

```tsx
"use client";

import type { ReactNode } from "react";
import { palette as c, cardShadow } from "../landing/theme";

interface AuthLayoutProps {
  featureContent: ReactNode;
  formContent: ReactNode;
}

export function AuthLayout({ featureContent, formContent }: AuthLayoutProps) {
  return (
    <main
      className="relative min-h-screen overflow-hidden"
      style={{ backgroundColor: c.pageBg, color: c.deep }}
    >
      <div className="relative mx-auto grid min-h-screen w-full max-w-6xl items-center gap-8 px-5 py-10 lg:grid-cols-[minmax(0,1fr)_minmax(380px,430px)] lg:gap-20 lg:px-10 xl:px-0">
        <div
          className="min-w-0 border-b pb-8 lg:border-b-0 lg:pb-0"
          style={{ borderColor: c.border }}
        >
          {featureContent}
        </div>

        <aside className="relative mx-auto w-full max-w-[430px] lg:justify-self-end">
          <div
            className="mb-4 flex items-center justify-between border-b pb-3 text-xs font-semibold uppercase tracking-[0.18em]"
            style={{ borderColor: c.border, color: c.subtle }}
          >
            <span>Matrix account</span>
            <span>Secure session</span>
          </div>
          <div
            className="relative overflow-hidden rounded-2xl p-4"
            style={{ backgroundColor: c.card, border: `1px solid ${c.border}`, boxShadow: cardShadow }}
          >
            {formContent}
          </div>
        </aside>
      </div>
    </main>
  );
}
```

- [ ] **Step 4: Polish `clerkAppearance.ts`**

In `www/src/components/auth/clerkAppearance.ts`, soften the form controls to match the `rounded-2xl` card (no behavior change):

```ts
  elements: {
    rootBox: "w-full",
    cardBox: "w-full !shadow-none !border-0",
    card: "!bg-transparent !shadow-none !border-0",
    headerTitle: "!tracking-[-0.02em]",
    socialButtonsBlockButton: "!h-11 !rounded-xl",
    formButtonPrimary: "!h-11 !rounded-xl !font-medium",
    formFieldInput: "!h-11 !rounded-xl",
  },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run test -- tests/www/auth-layout.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add www/src/components/auth/AuthLayout.tsx www/src/components/auth/clerkAppearance.ts tests/www/auth-layout.test.ts
git commit -m "feat(www): rework AuthLayout onto the landing card surface"
```

---

### Task 8: Verification — typecheck, patterns, react-doctor, screenshots

**Files:** none (verification only)

- [ ] **Step 1: Full unit suite for touched areas**

Run: `bun run test -- tests/www tests/shell`
Expected: PASS, including the new specs and existing `auth-routing` / `billing-section`.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no errors in `www` or `shell`.

- [ ] **Step 3: Pattern scanner**

Run: `bun run check:patterns`
Expected: no new violations (the `/welcome` catch logs an error name; no bare catch).

- [ ] **Step 4: React audit (mandatory for the `.tsx` changes)**

Run: `npx react-doctor@latest www` then `npx react-doctor@latest shell`
Expected: resolve any findings on the changed files before proceeding.

- [ ] **Step 5: Screenshot evidence**

With the Docker stack up (`http://localhost:3000`) and landing dev (`cd www && pnpm dev` → `http://localhost:3001`), capture via Playwright/Chrome MCP:
- `/sign-up` and `/sign-in` (redesigned left + card)
- landing `#pricing` with a hover state on a plan row
- (if a preview VPS/app is reachable) the billing picker showing the preselected plan after a `?plan=builder` sign-up
Save under the PR description / `specs/098-onboarding-billing-preselect/`.

- [ ] **Step 6: Final commit (screenshots / notes)**

```bash
git add specs/098-onboarding-billing-preselect
git commit -m "docs(098): onboarding polish verification evidence"
```

---

## Self-Review

- **Spec coverage:** Part 1 (auth left side) → Tasks 6–7. Part 2 (clickable billing) → Task 2. Part 3 (preselect via public metadata) → Tasks 1, 3, 4, 5. Part 4 (parity guard) → Task 1. State-machine safety (land on app root; preselect is UI-only) → Tasks 3, 4, 5. Testing/react-doctor/screenshots → each task + Task 8. All spec sections map to a task.
- **Placeholders:** none — every code/test step contains full content. The one runtime lookup (BillingPanel exported component name, Task 5 Step 1) is an explicit verification step with a documented fallback (render via `BillingSection`), not a placeholder.
- **Type consistency:** `parsePlanUrlSlug` returns `PlanSlug | null` and is used that way in sign-up + `/welcome`. `planSlugToFeatureSlug`/`preselectedFeatureSlug` map `planSlug → featureSlug` consistently against `MATRIX_BILLING_SERVER_PROFILES`. `selectedPlan` metadata key is written in `/welcome` and read in `BillingPanel` identically.
