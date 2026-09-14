// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatAttachments } from "../../packages/ui/src/chat/ChatAttachments";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(cleanup);

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
  fireEvent.click(screen.getByRole("button", { name: "Close image preview" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(thumbnail);
  fireEvent.click(thumbnail);
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: true, cancelable: true }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(thumbnail);
  fireEvent.click(screen.getByRole("dialog"));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("can enlarge an image without a filesystem path or navigation callback", () => {
  render(<ChatAttachments attachments={[{ kind: "image", id: "image", label: "Image.png", src: "/image.png" }]} />);
  fireEvent.click(screen.getByRole("button", { name: "Open image Image.png" }));
  expect(screen.getByRole("img", { name: "Full size Image.png" })).toBeTruthy();
});

it("retains file attachment navigation", () => {
  const open = vi.fn();
  render(<ChatAttachments attachments={[{ kind: "file", id: "file", label: "notes.txt", path: "temporary/notes.txt" }]} open={open} />);
  fireEvent.click(screen.getByRole("button", { name: "Preview notes.txt" }));
  expect(open).toHaveBeenCalledWith("temporary/notes.txt");
});
