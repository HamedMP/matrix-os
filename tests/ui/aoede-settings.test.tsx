// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AoedeSettings } from "../../packages/ui/src/aoede/AoedeSettings";
import { projectAoedeCanonical } from "../../packages/ui/src/aoede/projection";
import type { AoedeController, AoedeSnapshot } from "../../packages/ui/src/aoede/controller";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const catalog = createCanonicalProviderCatalogFixture();
catalog.instances[0]!.models.push({
  id: "gpt-5.7-sol", displayName: "GPT-5.7-Sol", availability: "available",
  capabilities: ["tools"], supportsVision: false, supportsToolUse: true,
});
const devices = [
  { deviceId: "mic_usb", kind: "audioinput" as const, label: "USB Mic" },
  { deviceId: "spk_hdmi", kind: "audiooutput" as const, label: "HDMI" },
];
const capability = {
  contractVersion: 1, status: "available" as const, surface: "web_canvas" as const,
  transportModes: ["relayed_websocket" as const], turnModes: ["hands_free" as const, "push_to_talk" as const],
  supportsInterruption: true, resume: "delivery_aware" as const, sessionOnly: "unsupported" as const,
  actionMode: "canonical_actions" as const, actionCancellation: "run" as const,
  supportsInputSelection: true, supportsOutputSelection: true,
};
function makeController() {
  return {
    listProviders: vi.fn(async () => catalog), listDevices: vi.fn(async () => devices),
    setTurnMode: vi.fn(async () => {}), setInputDevice: vi.fn(async () => true),
    setOutputDevice: vi.fn(async () => "applied" as const), setSelection: vi.fn(async () => true),
    setPreferredLanguage: vi.fn(async () => {}),
  } as unknown as AoedeController;
}
function makeSnapshot(overrides: Partial<AoedeSnapshot> = {}): AoedeSnapshot {
  return {
    visible: true, focusRevision: 0, status: "idle", microphoneActive: false,
    turnMode: "hands_free", preferredLanguage: "en", inputDeviceId: null, outputDeviceId: null, devicesRevision: 0,
    binding: { chatId: "chat_aoede", scope: { kind: "workspace", id: "main", label: "Workspace" },
      selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" }, capability },
    boundProviderInstanceId: null, lastActionCancelOutcome: null,
    canonical: projectAoedeCanonical(null), error: null, ...overrides,
  };
}

describe("Aoede settings", () => {
  it("shows the spoken language and routes Automatic through the controller", async () => {
    const controller = makeController();
    render(<AoedeSettings controller={controller} snapshot={makeSnapshot({ preferredLanguage: "ur" })} />);
    expect(screen.getByLabelText("Spoken language")).toHaveValue("ur");
    fireEvent.change(screen.getByLabelText("Spoken language"), { target: { value: "auto" } });
    await waitFor(() => expect(controller.setPreferredLanguage).toHaveBeenCalledWith("auto"));
  });
  it("renders the persisted turn mode and routes changes through the controller", async () => {
    const controller = makeController();
    render(<AoedeSettings controller={controller} snapshot={makeSnapshot()} />);
    expect(screen.getByLabelText("Hands free")).toBeChecked();
    fireEvent.click(screen.getByLabelText("Push to talk"));
    await waitFor(() => expect(controller.setTurnMode).toHaveBeenCalledWith("push_to_talk"));
  });
  it("lists provider instances/models from the canonical catalog and updates the selection", async () => {
    const controller = makeController();
    render(<AoedeSettings controller={controller} snapshot={makeSnapshot()} />);
    const model = await screen.findByLabelText("Model");
    expect(screen.getByLabelText("Provider")).toHaveValue("codex_fixture");
    expect(model).toHaveValue("gpt-5.6-sol");
    expect(controller.listProviders).toHaveBeenCalledTimes(1);
    fireEvent.change(model, { target: { value: "gpt-5.7-sol" } });
    await waitFor(() => expect(controller.setSelection).toHaveBeenCalledWith({ instanceId: "codex_fixture", model: "gpt-5.7-sol" }));
  });
  it("preserves an unavailable saved model and requires an explicit replacement", async () => {
    const controller = makeController();
    const snapshot = makeSnapshot();
    snapshot.binding!.selection.model = "provider-default";
    render(<AoedeSettings controller={controller} snapshot={snapshot} />);
    const model = await screen.findByLabelText("Model");
    expect(model).toHaveValue("provider-default");
    expect(screen.getByRole("option", { name: "Saved model unavailable" })).toBeDisabled();
    expect(screen.getByText("The saved model is unavailable. Choose an available model to restore voice.")).toBeInTheDocument();
    expect(controller.setSelection).not.toHaveBeenCalled();
    fireEvent.change(model, { target: { value: "gpt-5.6-sol" } });
    await waitFor(() => expect(controller.setSelection).toHaveBeenCalledWith({ instanceId: "codex_fixture", model: "gpt-5.6-sol" }));
  });
  it("locks the provider instance while a run is bound to the chat", async () => {
    render(<AoedeSettings controller={makeController()} snapshot={makeSnapshot({ boundProviderInstanceId: "codex_fixture" })} />);
    await screen.findByLabelText("Model");
    expect(screen.getByLabelText("Provider")).toBeDisabled();
    expect(screen.getByLabelText("Model")).toBeEnabled();
  });
  it("lists capture/playback devices and routes choices through the controller", async () => {
    const controller = makeController();
    render(<AoedeSettings controller={controller} snapshot={makeSnapshot()} />);
    const input = await screen.findByLabelText("Voice input");
    const output = screen.getByLabelText("Audio output");
    fireEvent.change(input, { target: { value: "mic_usb" } });
    fireEvent.change(output, { target: { value: "spk_hdmi" } });
    await waitFor(() => expect(controller.setInputDevice).toHaveBeenCalledWith("mic_usb"));
    await waitFor(() => expect(controller.setOutputDevice).toHaveBeenCalledWith("spk_hdmi"));
  });
  it("shows truthful recovery states when catalog or enumeration is unavailable", async () => {
    const controller = makeController();
    vi.mocked(controller.listProviders).mockResolvedValue(null);
    vi.mocked(controller.listDevices).mockResolvedValue(null);
    render(<AoedeSettings controller={controller} snapshot={makeSnapshot()} />);
    await screen.findByText("Provider list unavailable.");
    expect(screen.getByText(/Device list unavailable/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(controller.listProviders).toHaveBeenCalledTimes(2));
  });
});
