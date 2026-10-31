import { beforeEach, describe, expect, it, vi } from "vitest";
import { open, lstat, unlink } from "node:fs/promises";
import { writeChatExport } from "../../src/cli/chat-client.js";

vi.mock("node:fs/promises", () => ({ open: vi.fn(), lstat: vi.fn(), unlink: vi.fn() }));
const identity = { ino: 7, dev: 3, isFile: () => true };
const file = { stat: vi.fn(), writeFile: vi.fn(), sync: vi.fn(), close: vi.fn() };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(open).mockResolvedValue(file as never);
  file.stat.mockResolvedValue(identity); file.writeFile.mockResolvedValue(undefined);
  file.sync.mockResolvedValue(undefined); file.close.mockResolvedValue(undefined);
  vi.mocked(lstat).mockResolvedValue(identity as never); vi.mocked(unlink).mockResolvedValue(undefined);
});
describe("Chat export failure recovery", () => {
  it("preserves the save error and removes its partial file even when close fails", async () => {
    file.writeFile.mockRejectedValue(new Error("disk full"));
    file.close.mockRejectedValue(new Error("close failed"));
    await expect(writeChatExport("saved.json","content")).rejects.toMatchObject({code:"chat_export_failed"});
    expect(file.stat).toHaveBeenCalledTimes(1); expect(file.close).toHaveBeenCalledTimes(1);
    expect(unlink).toHaveBeenCalledWith("saved.json");
    expect(file.stat.mock.invocationCallOrder[0]).toBeLessThan(file.writeFile.mock.invocationCallOrder[0]!);
  });
  it.each(["writeFile","sync"] as const)("cancels during %s and removes the owned file", async step => {
    const stop = new AbortController();
    file[step].mockImplementation(async()=>{ stop.abort(); });
    await expect(writeChatExport("saved.json","content",stop.signal)).rejects.toMatchObject({code:"chat_cancelled"});
    expect(file.close).toHaveBeenCalledTimes(1); expect(unlink).toHaveBeenCalledWith("saved.json");
  });
  it("preserves a replacement file during failed export cleanup", async () => {
    file.writeFile.mockRejectedValue(new Error("disk full"));
    vi.mocked(lstat).mockResolvedValue({...identity,ino:8} as never);
    await expect(writeChatExport("saved.json","content")).rejects.toMatchObject({code:"chat_export_failed"});
    expect(unlink).not.toHaveBeenCalled();
  });
  it("attempts close when file identity lookup fails", async () => {
    file.stat.mockRejectedValue(new Error("stat failed"));
    await expect(writeChatExport("saved.json","content")).rejects.toMatchObject({code:"chat_export_failed"});
    expect(file.close).toHaveBeenCalledTimes(1); expect(file.writeFile).not.toHaveBeenCalled();
  });
});
