// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProviderModelPicker } from "@desktop/renderer/src/features/chat/ProviderModelPicker";
import { ordinaryOpenAiCatalog, openAiBinding, openAiApiId } from "../ui/ordinary-openai-api-fixture";
beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("Electron's real model picker preserves a current explicit Completions API on model change", () => {
 const change = vi.fn(); render(<ProviderModelPicker catalog={ordinaryOpenAiCatalog()} selection={{ instanceId: openAiApiId, model: "gpt-4.1", options: openAiBinding, interactionMode: "default", permissionMode: "supervised" }} instanceLocked onChange={change}/>);
 fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
 fireEvent.click(screen.getByRole("option", { name: "gpt-4.1-mini via Matrix AI · OpenAI API" }));
 expect(change).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ instanceId: openAiApiId, model: "gpt-4.1-mini", options: openAiBinding }));
});
