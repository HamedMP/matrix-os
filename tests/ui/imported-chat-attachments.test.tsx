// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatAttachments } from "../../packages/ui/src/chat/ChatAttachments.js";
describe("private imported Chat asset controls", () => {
  it("downloads an explicit validated asset without pretending it is a filesystem path", async () => {
    const importAsset = { chatId: "chat_synthetic", assetId: "019eb0ae-9a30-7541-bdb8-db4d17e65146", label: "Full message" };
    const openImportedAsset = vi.fn(async () => {});
    render(<ChatAttachments attachments={[{ id: importAsset.assetId, label: importAsset.label, kind: "file", importAsset }]} openImportedAsset={openImportedAsset} />);
    fireEvent.click(screen.getByRole("button", { name: "Download Full message" }));
    expect(openImportedAsset).toHaveBeenCalledWith(importAsset);
    await waitFor(() => expect(screen.getByRole("button", { name: "Download Full message" })).toHaveProperty("disabled", false));
  });
  it("reports safe download failure without exposing provider errors", async () => {
    const importAsset = { chatId: "chat_synthetic", assetId: "019eb0ae-9a30-7541-bdb8-db4d17e65146", label: "Imported file" };
    render(<ChatAttachments attachments={[{ id: importAsset.assetId, label: importAsset.label, kind: "file", importAsset }]}
      openImportedAsset={vi.fn(async () => { throw new Error("postgres://private-provider/secret"); })} />);
    fireEvent.click(screen.getByRole("button", { name: "Download Imported file" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Download unavailable. Try again.");
  });
});
