// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatApp } from "../../shell/src/components/ChatApp.js";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat.js";
import { CanonicalProviderCatalogSchema } from "@matrix-os/contracts";

vi.mock("@clerk/nextjs", async importOriginal => ({
  ...(await importOriginal<typeof import("@clerk/nextjs")>()), useOrganization: () => ({ organization: null }), useAuth: () => ({ userId: null, sessionId: null }),
}));
vi.mock("../../shell/src/components/chat-provider-onboarding", () => ({ ChatProviderOnboarding: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
beforeEach(() => { vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {}, clear() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([false, true])("uses the current source options before uploading ordinary Web Chat images (mobile=%s)", async mobile => {
  const catalog = createCanonicalProviderCatalogFixture(); const instance = catalog.instances[0]!;
  instance.id = "matrix_bot_default"; instance.driverKind = "matrix_bot";
  catalog.drivers.push({ kind: "matrix_bot", displayName: "Bot", adapterVersion: "1.0.0", capabilityClass: "system_agent" });
  instance.supports.attachments = ["image", "file"]; instance.models[0]!.supportsVision = true;
  instance.options = [{ id: "source", label: "Source", kind: "enum", placement: "composer", values: [{ value: "own", label: "Owner" }], defaultValue: "own" }];
  instance.defaultSelection = { instanceId: instance.id, model: instance.models[0]!.id, options: [{ id: "source", value: "own" }] };
  CanonicalProviderCatalogSchema.parse(catalog);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(catalog)));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const submit = vi.fn(async () => false);
  const view = render(<ChatApp mobile={mobile} messages={[]} busy={false} connected conversations={[]}
    onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={submit} providerSelection={instance.defaultSelection}/>);
  await waitFor(() => expect(screen.getByRole("button", { name: "Attach files" })).toHaveProperty("disabled", false));
  fireEvent.change(screen.getByRole("textbox", { name: "Message chat" }), { target: { value: "Keep source options" } });
  fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File([new Uint8Array(1024 * 1024 + 1)], "source.png", { type: "image/png" })] } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(screen.queryByText("Images for this Matrix AI source must total 1 MiB or less.")).toBeNull();
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(submit.mock.calls[0]?.[2]).toMatchObject({ modelOptions: [{ id: "source", value: "own" }] });
});
