import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The Clerk instance's display config points sign_in_url/sign_up_url at the
// hosted Account Portal (accounts.matrix-os.com). Clerk reads
// NEXT_PUBLIC_CLERK_SIGN_IN_URL / _SIGN_UP_URL to override that with the
// in-app routes, so those vars must be baked into every shell build with a
// safe /sign-in /sign-up default -- a missing value silently regresses that
// surface back to the Account Portal.
function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

describe("Clerk in-app auth URLs are baked into shell builds", () => {
  it("platform Cloud Run image (app.matrix-os.com auth shell) defaults to /sign-in /sign-up", () => {
    const dockerfile = read("Dockerfile.platform");
    expect(dockerfile).toMatch(/ARG NEXT_PUBLIC_CLERK_SIGN_IN_URL=\/sign-in/);
    expect(dockerfile).toMatch(/ARG NEXT_PUBLIC_CLERK_SIGN_UP_URL=\/sign-up/);
    expect(dockerfile).toMatch(/ENV NEXT_PUBLIC_CLERK_SIGN_IN_URL=\$NEXT_PUBLIC_CLERK_SIGN_IN_URL/);
    expect(dockerfile).toMatch(/ENV NEXT_PUBLIC_CLERK_SIGN_UP_URL=\$NEXT_PUBLIC_CLERK_SIGN_UP_URL/);

    const cloudbuild = read("cloudbuild.platform.yaml");
    expect(cloudbuild).toMatch(/_NEXT_PUBLIC_CLERK_SIGN_IN_URL: '\/sign-in'/);
    expect(cloudbuild).toMatch(/_NEXT_PUBLIC_CLERK_SIGN_UP_URL: '\/sign-up'/);
    expect(cloudbuild).toMatch(/NEXT_PUBLIC_CLERK_SIGN_IN_URL=\$\{_NEXT_PUBLIC_CLERK_SIGN_IN_URL\}/);
    expect(cloudbuild).toMatch(/NEXT_PUBLIC_CLERK_SIGN_UP_URL=\$\{_NEXT_PUBLIC_CLERK_SIGN_UP_URL\}/);
  });

  it("customer VPS host bundle defaults to /sign-in /sign-up", () => {
    const buildScript = read("scripts/build-host-bundle.sh");
    expect(buildScript).toMatch(/NEXT_PUBLIC_CLERK_SIGN_IN_URL="\$\{NEXT_PUBLIC_CLERK_SIGN_IN_URL:-\/sign-in\}"/);
    expect(buildScript).toMatch(/NEXT_PUBLIC_CLERK_SIGN_UP_URL="\$\{NEXT_PUBLIC_CLERK_SIGN_UP_URL:-\/sign-up\}"/);

    const releaseWorkflow = read(".github/workflows/host-bundle-release.yml");
    expect(releaseWorkflow).toMatch(/NEXT_PUBLIC_CLERK_SIGN_IN_URL:.*\|\| '\/sign-in'/);
    expect(releaseWorkflow).toMatch(/NEXT_PUBLIC_CLERK_SIGN_UP_URL:.*\|\| '\/sign-up'/);
  });

  it(".env.example documents the in-app routes, not stale localhost auth URLs", () => {
    const env = read(".env.example");
    expect(env).toMatch(/NEXT_PUBLIC_CLERK_SIGN_IN_URL=\/sign-in/);
    expect(env).toMatch(/NEXT_PUBLIC_CLERK_SIGN_UP_URL=\/sign-up/);
    expect(env).not.toMatch(/localhost:3001/);
  });

  it("relies on env vars, not a ClerkProvider prop override", () => {
    // The env method is the source of truth; ClerkProvider stays prop-free so
    // a stray prop cannot silently win over (and mask) the env configuration.
    const layout = read("shell/src/app/layout.tsx");
    expect(layout).toMatch(/<ClerkProvider>/);
    expect(layout).not.toMatch(/<ClerkProvider[^>]*signUpUrl=/);
  });

  it("forces shell Clerk completion back into the app shell", () => {
    const signIn = read("shell/src/app/sign-in/[[...sign-in]]/page.tsx");
    const signUp = read("shell/src/app/sign-up/[[...sign-up]]/page.tsx");

    expect(signIn).toContain('forceRedirectUrl="/"');
    expect(signUp).toContain('forceRedirectUrl="/"');
  });

  it("reuses the shared auth layout, feature showcase, and Clerk appearance", () => {
    const signIn = read("shell/src/app/sign-in/[[...sign-in]]/page.tsx");
    const signUp = read("shell/src/app/sign-up/[[...sign-up]]/page.tsx");
    const handoff = read("shell/src/components/auth/SignupBillingHandoff.tsx");

    for (const source of [signIn, signUp, handoff]) {
      expect(source).toContain('from "@/components/auth/AuthLayout"');
      expect(source).toContain('from "@/components/auth/FeatureShowcase"');
      expect(source).not.toContain("ShellAuthLayout");
    }
    expect(signIn).toContain("appearance={matrixClerkAppearance}");
    expect(signUp).toContain("appearance={matrixClerkAppearance}");
  });
});
