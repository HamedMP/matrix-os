// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AttachmentImage, ChatAttachments } from "../../packages/ui/src/chat/ChatAttachments";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("opens a square thumbnail in a dismissible overlay without navigating to Files", () => {
  const open = vi.fn();
  render(<ChatAttachments attachments={[{ kind: "image", id: "image", label: "Screenshot.png", src: "/image.png", path: "temporary/image.png" }]} open={open} />);
  const thumbnail = screen.getByRole("button", { name: "Open image Screenshot.png" });
  expect(thumbnail.style.width).toBe("96px");
  expect(thumbnail.style.height).toBe("96px");
  fireEvent.click(thumbnail);
  expect(open).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByRole("img", { name: "Full size Screenshot.png" }).getAttribute("src")).toBe("/image.png");
  fireEvent.click(screen.getByRole("button", { name: "Open Screenshot.png in File Preview" }));
  expect(open).toHaveBeenCalledWith("temporary/image.png");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(thumbnail);
  fireEvent.click(thumbnail);
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: true, cancelable: true }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(thumbnail);
  fireEvent.click(screen.getByRole("dialog"));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("keeps the enlarged image visible when File Preview declines the path", () => {
  render(<ChatAttachments attachments={[{ kind: "image", id: "image", label: "Image.png", src: "/image.png", path: "invalid" }]} open={() => false} />);
  fireEvent.click(screen.getByRole("button", { name: "Open image Image.png" }));
  fireEvent.click(screen.getByRole("button", { name: "Open Image.png in File Preview" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
});

it("can enlarge an image without a filesystem path or navigation callback", () => {
  render(<ChatAttachments attachments={[{ kind: "image", id: "image", label: "Image.png", src: "/image.png" }]} />);
  fireEvent.click(screen.getByRole("button", { name: "Open image Image.png" }));
  expect(screen.getByRole("img", { name: "Full size Image.png" })).toBeTruthy();
});

it("downloads the same bytes shown in an authenticated historical image and uses the source name", async () => {
  const original = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0x42])], { type: "image/jpeg" });
  const loadImage = vi.fn(async () => original);
  const createObjectURL = vi.fn((_blob: Blob) => "blob:historical-image");
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = createObjectURL;
    static revokeObjectURL = vi.fn();
  });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  render(<AttachmentImage src="~/temporary/november-chart.png" label="November analysis" path="~/temporary/november-chart.png" loadImage={loadImage} inline />);
  fireEvent.click(await screen.findByRole("button", { name: "Open image November analysis" }));
  fireEvent.click(screen.getByRole("button", { name: "Download image" }));
  expect(loadImage).toHaveBeenCalledOnce();
  expect(createObjectURL.mock.calls.every(([blob]) => blob === original)).toBe(true);
  expect(click.mock.contexts[0]).toMatchObject({ href: "blob:historical-image", download: "november-chart.jpg" });
});

it("shows a retryable preview and no download action when an image cannot be loaded", async () => {
  render(<AttachmentImage src="~/temporary/missing.png" label="Missing chart" loadImage={vi.fn().mockRejectedValue(new Error("Unavailable"))} />);
  expect(await screen.findByRole("button", { name: "Retry Missing chart" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Download image" })).toBeNull();
});

it("retains file attachment navigation", () => {
  const open = vi.fn();
  render(<ChatAttachments attachments={[{ kind: "file", id: "file", label: "notes.txt", path: "temporary/notes.txt" }]} open={open} />);
  fireEvent.click(screen.getByRole("button", { name: "Preview notes.txt" }));
  expect(open).toHaveBeenCalledWith("temporary/notes.txt");
});

it("allows assistant attachments to align with the left edge", () => {
  const { container } = render(
    <ChatAttachments
      align="start"
      attachments={[{ kind: "image", id: "image", label: "Generated.png", src: "/image.png" }]}
    />,
  );
  expect(container.firstElementChild?.className).toContain("justify-start");
  expect(container.firstElementChild?.className).not.toContain("ml-auto");
});
