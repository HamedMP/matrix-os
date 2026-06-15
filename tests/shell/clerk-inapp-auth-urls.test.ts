import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The Clerk instance's display config points sign_in_url/sign_up_url at the
// hosted Account Portal (accounts.matrix-os.com). ClerkProvider must override
// with in-app routes, or the "sign up" cross-link on /sign-in (and the signup
// flow itself) bounce to the Account Portal instead of staying on
// app.matrix-os.com. No NEXT_PUBLIC_CLERK_SIGN_*_URL build args exist, so the
// override has to live in code.
describe("shell ClerkProvider in-app auth URLs", () => {
  const layout = readFileSync(
    join(process.cwd(), "shell/src/app/layout.tsx"),
    "utf8",
  );

  it("pins signInUrl and signUpUrl on ClerkProvider to in-app routes", () => {
    expect(layout).toMatch(/<ClerkProvider[^>]*signInUrl="\/sign-in"/);
    expect(layout).toMatch(/<ClerkProvider[^>]*signUpUrl="\/sign-up"/);
  });

  it("does not leave ClerkProvider without auth URL overrides", () => {
    expect(layout).not.toMatch(/<ClerkProvider>\s*\n\s*<html/);
  });
});
