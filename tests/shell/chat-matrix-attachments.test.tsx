// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatInput } from "../../shell/src/components/chat/ChatInput";
import { useChatComposerDraft } from "../../shell/src/components/chat/useChatComposerDraft";
import { usePreviewWindow } from "../../shell/src/hooks/usePreviewWindow";
import { endMatrixFileDrag, startMatrixFileDrag } from "../../shell/src/lib/matrix-file-drag";

const gateway = "https://matrix.test/vm/computer/~runtime/review";
const isCurrent = () => true;

function Composer({ scope = "new", onSubmit = vi.fn(), isCurrentAuthority = isCurrent }: {
  scope?: string;
  onSubmit?: React.ComponentProps<typeof ChatInput>["onSubmit"];
  isCurrentAuthority?: () => boolean;
}) {
  const composer = useChatComposerDraft(scope, "owner");
  return <ChatInput key={scope} composer={composer} scope={scope} permissionMode="supervised" connected busy={false}
    onSubmit={onSubmit} attachmentsEnabled matrixGatewayUrl={gateway} isCurrentAuthority={isCurrentAuthority} />;
}

afterEach(() => {
  cleanup();
  endMatrixFileDrag();
  usePreviewWindow.setState({ draftAuthority: null });
  vi.unstubAllGlobals();
});

function setupRequests(content: () => Promise<Response> = async () => new Response("matrix bytes", {
  headers: { "content-type": "text/plain; charset=utf-8" },
})) {
  const requests = vi.fn(async (url: string) => {
    if (url.endsWith("/api/files/list?path=")) return Response.json({ entries: [{ name: "reports", type: "directory" }] });
    if (url.endsWith("/api/files/list?path=reports")) return Response.json({ entries: [{ name: "result.txt", type: "file" }] });
    return content();
  });
  vi.stubGlobal("fetch", requests);
  return requests;
}

async function chooseFile() {
  fireEvent.click(screen.getByRole("button", { name: "Matrix Files" }));
  fireEvent.click(await screen.findByRole("button", { name: "Open reports" }));
  fireEvent.click(await screen.findByRole("button", { name: "Attach result.txt" }));
}

it("reads the chosen computer file and submits its original bytes through the attachment queue", async () => {
  const requests = setupRequests();
  const onSubmit = vi.fn();
  render(<Composer onSubmit={onSubmit} />);
  await chooseFile();
  await screen.findByText("result.txt");
  expect(requests).toHaveBeenCalledWith(
    `${gateway}/api/file-previews/content?kind=home&path=reports%2Fresult.txt&download=true`,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
    "Attached 1 file(s)",
    [{ name: "result.txt", type: "text/plain", data: "data:text/plain;base64,bWF0cml4IGJ5dGVz" }],
    expect.any(Object),
  ));
});

it("discards a late picker read once Chat or its computer authority changes", async () => {
  let resolve!: (response: Response) => void;
  const requests = setupRequests(() => new Promise<Response>((finish) => { resolve = finish; }));
  const view = render(<Composer />);
  await chooseFile();
  await waitFor(() => expect(resolve).toBeTypeOf("function"));
  view.rerender(<Composer scope="another-chat" />);
  view.rerender(<Composer scope="new" />);
  const signal = (requests.mock.calls[2] as unknown as [string, RequestInit])[1].signal;
  expect(signal?.aborted).toBe(true);
  await act(async () => resolve(new Response("old result", { headers: { "content-type": "text/plain" } })));
  expect(screen.queryByText("result.txt")).toBeNull();
});

it("keeps a read during a harmless authority callback rerender but discards it on authority loss", async () => {
  let resolve!: (response: Response) => void;
  const requests = setupRequests(() => new Promise<Response>((finish) => { resolve = finish; }));
  const view = render(<Composer />);
  await chooseFile();
  await waitFor(() => expect(resolve).toBeTypeOf("function"));
  view.rerender(<Composer isCurrentAuthority={() => true} />);
  const signal = (requests.mock.calls[2] as unknown as [string, RequestInit])[1].signal;
  expect(signal?.aborted).toBe(false);
  view.rerender(<Composer isCurrentAuthority={() => false} />);
  await act(async () => resolve(new Response("old result", { headers: { "content-type": "text/plain" } })));
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByText("result.txt")).toBeNull();
});

function transferWith(files: File[] = []) {
  const data: Record<string, string> = {};
  return {
    files,
    get types() { return [...Object.keys(data), ...(files.length ? ["Files"] : [])]; },
    setData: (type: string, value: string) => { data[type] = value; },
    getData: (type: string) => data[type] ?? "",
  } as unknown as DataTransfer;
}

it("accepts one active Files drag for this computer and rejects repeats and other scopes", async () => {
  const requests = setupRequests();
  usePreviewWindow.setState({ draftAuthority: "active-owner" });
  render(<Composer />);
  const drop = (authority: string, source = gateway) => {
    const transfer = transferWith();
    startMatrixFileDrag(transfer, "report.txt", authority, source);
    fireEvent.drop(screen.getByRole("textbox", { name: "Message chat" }), { dataTransfer: transfer });
  };
  drop("different-owner");
  drop("active-owner", "https://matrix.test/vm/other");
  expect(requests).not.toHaveBeenCalled();
  drop("active-owner");
  await screen.findByText("report.txt");
  drop("active-owner");
  expect((await screen.findByRole("alert")).textContent).toContain("This Matrix file is already attached.");
  expect(requests).toHaveBeenCalledTimes(1);
});

it("keeps oversized Matrix files out of the attachment queue", async () => {
  setupRequests(async () => new Response("unused stream", { headers: { "content-length": "11000000" } }));
  render(<Composer />);
  await chooseFile();
  expect((await screen.findByRole("alert")).textContent).toContain("exceeds the attachment size limit");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByText("result.txt")).toBeNull();
});

it("keeps device file selection, drop and paste available", async () => {
  render(<Composer />);
  const text = screen.getByRole("textbox", { name: "Message chat" });
  fireEvent.change(screen.getByLabelText("Attach files", { selector: "input" }), {
    target: { files: [new File(["chosen"], "chosen.txt", { type: "text/plain" })] },
  });
  fireEvent.drop(text, { dataTransfer: transferWith([new File(["drop"], "drop.txt", { type: "text/plain" })]) });
  fireEvent.paste(text, { clipboardData: transferWith([new File(["paste"], "paste.txt", { type: "text/plain" })]) });
  for (const name of ["chosen.txt", "drop.txt", "paste.txt"]) expect(screen.getByText(name)).toBeTruthy();
});

it("hands the picker footer back to device selection without clearing the draft", async () => {
  setupRequests();
  render(<Composer />);
  const text = screen.getByRole("textbox", { name: "Message chat" });
  fireEvent.change(text, { target: { value: "Keep this draft" } });
  const input = screen.getByLabelText("Attach files", { selector: "input" }) as HTMLInputElement;
  const openDevice = vi.spyOn(input, "click");
  fireEvent.click(screen.getByRole("button", { name: "Matrix Files" }));
  await screen.findByRole("button", { name: "Open reports" });
  fireEvent.click(screen.getByRole("button", { name: "Upload from device" }));
  expect(openDevice).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog", { name: "Attach files" })).toBeNull();
  expect((text as HTMLTextAreaElement).value).toBe("Keep this draft");
  fireEvent.change(input, { target: { files: [new File(["local bytes"], "chosen.txt", { type: "text/plain" })] } });
  expect(screen.getByText("chosen.txt")).toBeTruthy();
  openDevice.mockRestore();
});
