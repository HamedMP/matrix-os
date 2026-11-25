// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createMessagingBridgeClient } from "../../../packages/ui/src/messaging/bridge-client";
import { LinkAccountDialog } from "../../../packages/ui/src/messaging/LinkAccountDialog";
import { deferred, fakeGateway, progress } from "./fixtures";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute("open"); };
});
afterEach(() => cleanup());

const LINK = "/api/messages/bridge";

function renderDialog(network: "whatsapp" | "telegram" | "linkedin", routes: Parameters<typeof fakeGateway>[0]) {
  const gateway = fakeGateway(routes);
  const onClose = vi.fn();
  const onLinked = vi.fn();
  render(<LinkAccountDialog network={network} client={createMessagingBridgeClient(gateway.fetch)} onClose={onClose} onLinked={onLinked} />);
  return { gateway, onClose, onLinked };
}

describe("link dialog", () => {
  it("warns about the unofficial connection before starting, and Cancel starts nothing", () => {
    const { gateway, onClose } = renderDialog("whatsapp", {});
    expect(screen.getByRole("note").textContent).toMatch(/unofficial connection.*may warn you.*restrict your account/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(gateway.requests).toHaveLength(0);
  });

  it("does not show the unofficial warning for Telegram", () => {
    renderDialog("telegram", {});
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("renders a scannable QR, long-polls until the step changes, then completes", async () => {
    const rotate = deferred<{ body: unknown }>();
    const scan = deferred<{ body: unknown }>();
    let polls = 0;
    const { gateway, onLinked } = renderDialog("whatsapp", {
      [`POST ${LINK}/whatsapp/link`]: () => ({ body: progress("whatsapp", { type: "display_and_wait", stepId: "qr-1", instructions: "Open WhatsApp, then Linked devices.", display: { kind: "qr", data: "2@first" } }) }),
      [`POST ${LINK}/whatsapp/link/link-1/step`]: () => {
        polls += 1;
        return polls === 1 ? rotate.promise : scan.promise;
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const qr = await screen.findByRole("img", { name: "WhatsApp link QR code" });
    expect(qr.querySelector("path")?.getAttribute("d")).toMatch(/^M\d+ \d+h1v1h-1z/);
    expect(screen.getByText("Open WhatsApp, then Linked devices.")).toBeTruthy();
    const firstCode = qr.querySelector("path")?.getAttribute("d");
    await act(async () => rotate.resolve({ body: progress("whatsapp", { type: "display_and_wait", stepId: "qr-2", display: { kind: "qr", data: "2@rotated-code" } }) }));
    await waitFor(() => expect(polls).toBe(2));
    expect(screen.getByRole("img", { name: "WhatsApp link QR code" }).querySelector("path")?.getAttribute("d")).not.toBe(firstCode);
    expect(gateway.requests.filter((r) => r.path.endsWith("/step")).map((r) => r.body)).toEqual([{ stepId: "qr-1" }, { stepId: "qr-2" }]);
    expect(onLinked).not.toHaveBeenCalled();
    await act(async () => scan.resolve({ body: progress("whatsapp", { type: "complete", loginId: "wa-1", displayName: "My phone" }) }));
    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1));
  });

  it("shows a pairing code for code displays", async () => {
    renderDialog("whatsapp", {
      [`POST ${LINK}/whatsapp/link`]: () => ({ body: progress("whatsapp", { type: "display_and_wait", stepId: "code-1", display: { kind: "code", data: "ABCD-EFGH" } }) }),
      [`POST ${LINK}/whatsapp/link/link-1/step`]: () => new Promise(() => {}),
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((await screen.findByLabelText("Pairing code")).textContent).toBe("ABCD-EFGH");
  });

  it("Cancel and Escape abort the in-flight long-poll", async () => {
    const { gateway, onClose } = renderDialog("whatsapp", {
      [`POST ${LINK}/whatsapp/link`]: () => ({ body: progress("whatsapp", { type: "display_and_wait", stepId: "qr-1", display: { kind: "qr", data: "2@x" } }) }),
      [`POST ${LINK}/whatsapp/link/link-1/step`]: () => new Promise(() => {}),
      [`POST ${LINK}/whatsapp/link/link-1/cancel`]: () => ({ body: { ok: true } }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(gateway.requests.some((r) => r.path.endsWith("/step"))).toBe(true));
    const poll = gateway.requests.find((r) => r.path.endsWith("/step"))!;
    expect(poll.signal?.aborted).toBe(false);
    fireEvent(document.querySelector("dialog")!, new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalled();
    expect(poll.signal?.aborted).toBe(true);
    expect(gateway.requests.filter((r) => r.path.endsWith("/cancel")).map((r) => r.method)).toEqual(["POST"]);
  });

  it.each([
    ["light dismiss", (dialog: HTMLDialogElement) => fireEvent.click(dialog)],
    ["unmount", () => cleanup()],
  ])("releases the in-progress link on %s", async (_label, dismiss) => {
    const { gateway } = renderDialog("telegram", {
      [`POST ${LINK}/telegram/link`]: () => ({
        body: progress("telegram", { type: "user_input", stepId: "phone", fields: [{ id: "phone", label: "Phone number", kind: "phone", required: true }] }),
      }),
      [`POST ${LINK}/telegram/link/link-1/cancel`]: () => ({ status: 503, body: { error: { code: "bridge_unavailable", message: "x" } } }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByLabelText("Phone number");
    const dialog = document.querySelector("dialog")!;
    dismiss(dialog);
    await waitFor(() => expect(gateway.requests.filter((r) => r.path.endsWith("/cancel"))).toHaveLength(1));
    expect(document.querySelector("[role=alert]")).toBeNull();
  });

  it("submits a 16,384-character secret intact", async () => {
    const cookie = "c".repeat(16_384);
    const { gateway } = renderDialog("linkedin", {
      [`POST ${LINK}/linkedin/link`]: () => ({
        body: progress("linkedin", { type: "user_input", stepId: "cookies", fields: [{ id: "cookie", label: "Cookie header", kind: "secret", required: true }] }),
      }),
      [`POST ${LINK}/linkedin/link/link-1/step`]: () => ({ body: progress("linkedin", { type: "complete", loginId: "li-1" }) }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const field = (await screen.findByLabelText("Cookie header")) as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.change(field, { target: { value: cookie } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(gateway.requests).toHaveLength(2));
    expect((gateway.requests[1]?.body as { fields: { cookie: string } }).fields.cookie).toBe(cookie);
  });

  it("shows a waiting state while the link starts", async () => {
    renderDialog("whatsapp", { [`POST ${LINK}/whatsapp/link`]: () => new Promise(() => {}) });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((await screen.findByRole("status")).textContent).toBe("Connecting to WhatsApp…");
  });

  it("renders choice fields as a list of the offered options and submits the chosen one", async () => {
    const { gateway, onLinked } = renderDialog("linkedin", {
      [`POST ${LINK}/linkedin/link`]: () => ({
        body: progress("linkedin", {
          type: "user_input",
          stepId: "pick",
          fields: [{ id: "browser", label: "Browser", kind: "choice", required: true, options: ["Chrome", "Firefox"] }],
        }),
      }),
      [`POST ${LINK}/linkedin/link/link-1/step`]: () => ({ body: progress("linkedin", { type: "complete", loginId: "li-1" }) }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const choice = (await screen.findByLabelText("Browser")) as HTMLSelectElement;
    expect(Array.from(choice.options).filter((o) => !o.disabled).map((o) => o.value)).toEqual(["Chrome", "Firefox"]);
    fireEvent.change(choice, { target: { value: "Firefox" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onLinked).toHaveBeenCalled());
    expect(gateway.requests[1]?.body).toEqual({ stepId: "pick", fields: { browser: "Firefox" } });
    expect(gateway.requests.some((r) => r.path.endsWith("/cancel"))).toBe(false);
  });

  it("renders user_input fields by kind, masks codes and secrets, and submits the values", async () => {
    const { gateway } = renderDialog("telegram", {
      [`POST ${LINK}/telegram/link`]: () => ({
        body: progress("telegram", {
          type: "user_input",
          stepId: "phone",
          instructions: "Enter the phone number on your Telegram account.",
          fields: [{ id: "phone_number", label: "Phone number", kind: "phone", required: true }],
        }),
      }),
      [`POST ${LINK}/telegram/link/link-1/step`]: (request) =>
        (request.body as { stepId: string }).stepId === "phone"
          ? {
              body: progress("telegram", {
                type: "user_input",
                stepId: "code",
                helpUrl: "https://telegram.org/faq",
                fields: [
                  { id: "code", label: "Login code", kind: "code", required: true },
                  { id: "password", label: "Two-step password", kind: "secret", required: false, description: "Only if you set one." },
                ],
              }),
            }
          : { body: progress("telegram", { type: "complete", loginId: "tg-1" }) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const phone = (await screen.findByLabelText("Phone number")) as HTMLInputElement;
    expect(phone.type).toBe("tel");
    expect(screen.getByText("Enter the phone number on your Telegram account.")).toBeTruthy();
    fireEvent.change(phone, { target: { value: " +46700000000 " } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const code = (await screen.findByLabelText("Login code")) as HTMLInputElement;
    const password = screen.getByLabelText("Two-step password") as HTMLInputElement;
    expect([code.type, password.type]).toEqual(["password", "password"]);
    expect(password.autocomplete).toBe("off");
    expect(screen.getByRole("link", { name: "Open the help page" }).getAttribute("href")).toBe("https://telegram.org/faq");
    fireEvent.change(code, { target: { value: "12345" } });
    fireEvent.change(password, { target: { value: " hunter2 " } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(gateway.requests).toHaveLength(3));
    expect(gateway.requests.slice(1).map((r) => r.body)).toEqual([
      { stepId: "phone", fields: { phone_number: "+46700000000" } },
      { stepId: "code", fields: { code: "12345", password: " hunter2 " } },
    ]);
  });

  it("shows a plain retry message for a failed step and retries from the start", async () => {
    let starts = 0;
    renderDialog("linkedin", {
      [`POST ${LINK}/linkedin/link`]: () => {
        starts += 1;
        return { body: progress("linkedin", { type: "failed", reason: "expired" }) };
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The link request expired. Try again.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(starts).toBe(2));
  });

  it("shows the allowlisted message when starting is rate limited", async () => {
    renderDialog("telegram", {
      [`POST ${LINK}/telegram/link`]: () => ({ status: 429, body: { error: { code: "rate_limited", message: "bucket telegram:owner exhausted" } } }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Too many attempts. Wait a moment and try again.");
  });
});
