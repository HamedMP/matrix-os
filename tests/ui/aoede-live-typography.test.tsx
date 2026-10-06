// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AoedeLivePanel } from "../../packages/ui/src/aoede/AoedeLivePanel";
import type { AoedePanelProps } from "../../packages/ui/src/aoede/AoedePanel";

afterEach(() => { cleanup(); document.querySelectorAll("style[data-voice-type-test]").forEach(node => node.remove()); });

const css = readFileSync(resolve("packages/ui/src/aoede/aoede-live.css"), "utf8");
const response = "I can help you build apps and answer questions.";

describe("Figma Desktop voice typography", () => {
  it.each(["web_canvas", "web_desktop", "electron_desktop"] as const)("keeps %s captions stable through streaming and completion", surface => {
    const sheet = document.createElement("style");
    sheet.dataset.voiceTypeTest = "true";
    sheet.textContent = css;
    document.head.append(sheet);
    const props: AoedePanelProps = {
      surface, scopeLabel: "Workspace", status: "speaking", turnMode: "hands_free",
      microphoneActive: true, captions: { response },
      capability: { contractVersion: 1, status: "available", surface,
        transportModes: ["relayed_websocket"], turnModes: ["hands_free"],
        conversationMode: "native_live", supportsInterruption: true, resume: "rebuild_only",
        sessionOnly: "unsupported", actionMode: "conversation_only", actionCancellation: "none",
        supportsInputSelection: false, supportsOutputSelection: false },
      commands: { start: vi.fn(), dismiss: vi.fn(), end: vi.fn(), pause: vi.fn(),
        resume: vi.fn(), stopSpeaking: vi.fn(), pushToTalkStart: vi.fn(), pushToTalkStop: vi.fn(),
        retry: vi.fn(), newConversation: vi.fn(), viewHistory: vi.fn() },
    };
    const view = render(<AoedeLivePanel {...props} />);
    const type = () => {
      const style = getComputedStyle(screen.getByRole("region", { name: "Current response" }).parentElement!);
      return { family: style.fontFamily, size: style.fontSize, lineHeight: style.lineHeight };
    };
    const streaming = type();
    expect(streaming).toEqual({ family: "var(--live-sans)", size: "14px", lineHeight: "1.45" });
    for (const status of ["listening", "thinking", "using_tool", "paused", "ended", "idle"] as const) {
      view.rerender(<AoedeLivePanel {...props} status={status} microphoneActive={status !== "ended" && status !== "idle"} />);
      expect(type(), `Caption typography after ${status}`).toEqual(streaming);
      expect(screen.getByRole("region", { name: "Current response" }).textContent).toContain(response);
    }
    const layer = screen.getByRole("dialog").parentElement!;
    expect(layer.style.getPropertyValue("--live-sans")).toBe("var(--font-geist-sans, Geist), system-ui, sans-serif");
    expect(layer.style.getPropertyValue("--live-widget")).toBe("#FFFEFC");
    expect(layer.style.getPropertyValue("--live-border")).toBe("#ECEAE8");
    expect(layer.style.getPropertyValue("--live-text")).toBe("#242323");
    expect(layer.style.getPropertyValue("--live-serif")).toBe("");
  });

  it("ships the approved Geist face in Electron rather than relying on an installed system font", () => {
    const desktop = JSON.parse(readFileSync(resolve("desktop/package.json"), "utf8"));
    const styles = readFileSync(resolve("desktop/src/renderer/src/design/index.css"), "utf8");
    expect(desktop.dependencies["@fontsource-variable/geist"]).toBe("5.3.0");
    expect(styles).toContain('@import "@fontsource-variable/geist/wght.css"');
  });
});
