import type { Page } from "playwright";

const NAVIGATION_NAMES = ["Home", "Chat", "Terminal", "Files"] as const;

export interface DesktopHandoffBaselineEvidence {
  navigationNames: string[];
  focusTargets: Record<(typeof NAVIGATION_NAMES)[number], string>;
  historyTargets: { back: string; forward: string } | null;
  recentConversationTarget: string | null;
  hiddenPanesMissingInert: number;
  narrowViewport: {
    width: number;
    hasHorizontalDocumentOverflow: boolean;
  };
  reducedMotion: "no-preference" | "reduce";
}

async function ensureSignedIn(page: Page): Promise<void> {
  const continueButton = page.getByRole("button", {
    name: /continue in browser/i,
  });
  const terminalNavigation = page
    .locator("aside button", { hasText: "Terminal" })
    .first();
  const bootState = await Promise.race([
    continueButton
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => "signed-out" as const),
    terminalNavigation
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => "signed-in" as const),
  ]);
  if (bootState === "signed-out") {
    await continueButton.click();
  }
  await terminalNavigation.waitFor({ timeout: 15_000 });
}

async function waitForSurface(page: Page, name: (typeof NAVIGATION_NAMES)[number]) {
  switch (name) {
    case "Home":
      await page.locator("aside").waitFor();
      return;
    case "Chat":
      await page
        .locator(
          '[role="region"][aria-label="Hermes conversation"], #conversation-index-title',
        )
        .first()
        .waitFor({ timeout: 10_000 });
      return;
    case "Terminal":
      await Promise.race([
        page
          .getByRole("heading", { name: "Terminal" })
          .waitFor({ timeout: 10_000 }),
        page.getByText("Shells").first().waitFor({ timeout: 10_000 }),
      ]);
      return;
    case "Files":
      await page
        .getByRole("heading", { name: "Files" })
        .waitFor({ timeout: 10_000 });
  }
}

export async function inspectDesktopHandoffBaseline(
  page: Page,
): Promise<DesktopHandoffBaselineEvidence> {
  await ensureSignedIn(page);
  await page.emulateMedia({ reducedMotion: "reduce" });

  const navigationNames: string[] = [];
  const focusTargets = {
    Home: "",
    Chat: "",
    Terminal: "",
    Files: "",
  };

  for (const name of NAVIGATION_NAMES) {
    const button = page
      .locator("aside")
      .getByRole("button", { name, exact: true })
      .first();
    await button.waitFor({ state: "visible" });
    navigationNames.push(name);
    await button.focus();
    await page.keyboard.press("Enter");
    await waitForSurface(page, name);
    focusTargets[name] = await page.evaluate(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return "";
      return (
        active.getAttribute("aria-label") ??
        active.getAttribute("placeholder") ??
        active.textContent?.trim() ??
        ""
      );
    });
  }

  let historyTargets: DesktopHandoffBaselineEvidence["historyTargets"] = null;
  const hasCombinedNavigation =
    (await page.getByRole("navigation", { name: "Breadcrumb" }).count()) > 0;
  const goBack = page.getByRole("button", { name: "Go back" });
  if ((await goBack.count()) > 0 && await goBack.isEnabled()) {
    await goBack.click();
    await waitForSurface(page, "Terminal");
    await page.getByRole("button", { name: "Go forward" }).click();
    await waitForSurface(page, "Files");
    historyTargets = { back: "Terminal", forward: "Files" };
  } else if (hasCombinedNavigation) {
    throw new Error("Combined Desktop navigation did not expose usable Back/Forward history");
  }

  let recentConversationTarget: string | null = null;
  const recentConversation = page.getByRole("button", {
    name: "Open recent Plan the persistent Desktop conversation experience",
  });
  if ((await recentConversation.count()) > 0) {
    await recentConversation.click();
    await waitForSurface(page, "Chat");
    recentConversationTarget = "Conversations";
  } else if (hasCombinedNavigation) {
    throw new Error("Combined Desktop navigation did not expose the canonical Gateway conversation Recent");
  }

  const hiddenPanesMissingInert = await page.evaluate(
    () =>
      document.querySelectorAll(
        '[aria-hidden="true"][style*="visibility: hidden"]:not([inert])',
      ).length,
  );

  await page.setViewportSize({ width: 820, height: 720 });
  const narrowViewport = await page.evaluate(() => ({
    width: window.innerWidth,
    hasHorizontalDocumentOverflow:
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth,
  }));
  const reducedMotion = await page.evaluate(() =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "reduce"
      : "no-preference",
  );

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ reducedMotion: "no-preference" });

  return {
    navigationNames,
    focusTargets,
    historyTargets,
    recentConversationTarget,
    hiddenPanesMissingInert,
    narrowViewport,
    reducedMotion,
  };
}
