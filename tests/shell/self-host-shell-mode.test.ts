// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import RootLayout from "../../shell/src/app/layout";
import { useCollaborationOrganization } from "../../shell/src/lib/collaboration-organization-state";

vi.mock("@clerk/nextjs", () => {
  const unavailable = () => { throw new Error("Clerk must not load in standalone or bypass mode"); };
  return {
    ClerkProvider: unavailable,
    useAuth: unavailable,
    useUser: unavailable,
    useOrganization: unavailable,
    useOrganizationList: unavailable,
  };
});

afterEach(() => vi.unstubAllEnvs());

function ShellContent() {
  const organization = useCollaborationOrganization();
  return createElement("main", {
    "data-membership": organization.status,
    "data-organization": organization.organizationId ?? "",
  }, "owner shell");
}

it.each([
  { selfHosted: "1", bypass: "0", membership: "none" },
  { selfHosted: "0", bypass: "1", membership: "loading" },
  { selfHosted: "1", bypass: "1", membership: "none" },
])("renders the owner shell without Clerk for selfHosted=$selfHosted, bypass=$bypass", ({ selfHosted, bypass, membership }) => {
  vi.stubEnv("MATRIX_SELF_HOSTED", selfHosted);
  vi.stubEnv("NEXT_PUBLIC_E2E_TEST_BYPASS", bypass);
  const markup = renderToStaticMarkup(createElement(RootLayout, { children: createElement(ShellContent) }));
  const document = new DOMParser().parseFromString(markup, "text/html");
  const content = document.querySelector("main");
  expect(content?.textContent).toBe("owner shell");
  expect(content?.getAttribute("data-membership")).toBe(membership);
  expect(content?.getAttribute("data-organization")).toBe("");
});
