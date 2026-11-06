// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

type ProviderProps = {
  connections?: { connectingService: string | null; failedServices: readonly string[]; changeCount: number };
  children?: React.ReactNode;
};
const providerProps = vi.hoisted(() => ({ current: null as null | ProviderProps }));
const viewProps = vi.hoisted(() => ({ current: null as null | { onAction(action: unknown): void } }));
const appConnect = vi.hoisted(() => ({
  connectApp: vi.fn(),
  connectingService: "google_calendar" as string | null,
  appsUnavailable: false,
}));
vi.mock("@desktop/renderer/src/features/onboarding-widget/use-onboarding-app-connect", () => ({
  useOnboardingAppConnect: () => appConnect,
}));
vi.mock("@matrix-os/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@matrix-os/ui")>();
  return {
    ...actual,
    GettingStartedAppProvider: (props: ProviderProps) => {
      providerProps.current = props;
      return <>{props.children}</>;
    },
    GettingStartedAppView: (props: { onAction(action: unknown): void }) => {
      viewProps.current = props;
      return null;
    },
  };
});

import {
  DesktopGettingStartedAppHost,
  DesktopGettingStartedAppWindow,
} from "@desktop/renderer/src/features/getting-started-app/DesktopGettingStartedAppHost";
import { useUi } from "@desktop/renderer/src/stores/ui";

afterEach(() => {
  cleanup();
  appConnect.connectApp.mockReset();
  appConnect.appsUnavailable = false;
});

function renderHost() {
  return render(
    <DesktopGettingStartedAppHost>
      <DesktopGettingStartedAppWindow />
    </DesktopGettingStartedAppHost>,
  );
}

describe("Electron Getting started app sign-ins", () => {
  it("starts an app's own sign-in from a card and shares its state with the app", () => {
    renderHost();
    expect(providerProps.current?.connections).toEqual({ connectingService: "google_calendar", failedServices: [], changeCount: 0 });
    act(() => viewProps.current?.onAction({ type: "connect", service: "gmail" }));
    expect(appConnect.connectApp).toHaveBeenCalledWith("gmail");
  });

  it("opens Settings › Integrations instead when this computer has no app connection service", () => {
    appConnect.appsUnavailable = true;
    const requestSettingsSection = vi.spyOn(useUi.getState(), "requestSettingsSection");
    renderHost();
    act(() => viewProps.current?.onAction({ type: "connect", service: "gmail" }));
    expect(appConnect.connectApp).not.toHaveBeenCalled();
    expect(requestSettingsSection).toHaveBeenCalledWith("services");
  });
});
