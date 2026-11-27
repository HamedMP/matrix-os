// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CSV_MIME,
  DOCX_MIME,
  LocalFileError,
  MAX_LOCAL_FILE_BYTES,
  TSV_MIME,
  XLSX_MIME,
  downloadBytes,
  pickLocalFile,
  readDroppedFile,
} from "../../../home/apps/_shared/office-ui";

function fileOf(name: string, text = "hello", lastModified = 1_700_000_000_000): File {
  return new File([text], name, { lastModified });
}

function setFiles(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, "files", { configurable: true, value: files });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("MIME constants", () => {
  it("names the office formats", () => {
    expect(DOCX_MIME).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(XLSX_MIME).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(CSV_MIME).toBe("text/csv");
    expect(TSV_MIME).toBe("text/tab-separated-values");
    expect(MAX_LOCAL_FILE_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe("pickLocalFile", () => {
  it("opens a hidden file input with the accept list and resolves the chosen file's bytes", async () => {
    let seen: HTMLInputElement | null = null;
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      seen = this;
      setFiles(this, [fileOf("Report.DOCX", "abc")]);
      this.dispatchEvent(new Event("change"));
    });
    const result = await pickLocalFile({ accept: [".docx", ".txt"] });
    expect(seen).not.toBeNull();
    expect(seen!.type).toBe("file");
    expect(seen!.accept).toBe(".docx,.txt");
    expect(result?.name).toBe("Report.DOCX");
    expect(Array.from(result!.bytes)).toEqual([97, 98, 99]);
    expect(result?.lastModified).toBe(1_700_000_000_000);
    expect(seen!.isConnected).toBe(false);
  });

  it("resolves null when the picker reports cancel", async () => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      this.dispatchEvent(new Event("cancel"));
    });
    await expect(pickLocalFile({ accept: [".csv"] })).resolves.toBeNull();
    expect(document.querySelector("input[type=file]")).toBeNull();
  });

  it("falls back to null when focus returns and no file arrives", async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    const pending = pickLocalFile({ accept: [".csv"] });
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(1500);
    await expect(pending).resolves.toBeNull();
    expect(document.querySelector("input[type=file]")).toBeNull();
  });

  it("still delivers a file whose change event lands just after focus returns", async () => {
    vi.useFakeTimers();
    let input: HTMLInputElement | null = null;
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      input = this;
    });
    const pending = pickLocalFile({ accept: [".csv"] });
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(200);
    setFiles(input!, [fileOf("late.csv", "a,b")]);
    input!.dispatchEvent(new Event("change"));
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toMatchObject({ name: "late.csv" });
  });

  it("settles an earlier pending picker with null when a new one opens", async () => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    const first = pickLocalFile({ accept: [".csv"] });
    void pickLocalFile({ accept: [".csv"] });
    await expect(first).resolves.toBeNull();
    expect(document.querySelectorAll("input[type=file]")).toHaveLength(1);
  });

  it("rejects a file above the size limit with a typed error", async () => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      setFiles(this, [fileOf("big.csv", "123456")]);
      this.dispatchEvent(new Event("change"));
    });
    const error = await pickLocalFile({ accept: [".csv"], maxBytes: 4 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LocalFileError);
    expect((error as LocalFileError).code).toBe("too-large");
  });

  it("rejects a file whose type is outside the accept list", async () => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      setFiles(this, [fileOf("photo.png")]);
      this.dispatchEvent(new Event("change"));
    });
    const error = await pickLocalFile({ accept: [".csv", ".tsv"] }).catch((e: unknown) => e);
    expect((error as LocalFileError).code).toBe("wrong-type");
    expect((error as LocalFileError).message).toContain(".csv");
  });
});

describe("readDroppedFile", () => {
  it("accepts a matching extension in any letter case", async () => {
    const result = await readDroppedFile({ files: [fileOf("DATA.CSV", "x,y")] }, [".csv"]);
    expect(result.name).toBe("DATA.CSV");
    expect(new TextDecoder().decode(result.bytes)).toBe("x,y");
  });

  it("accepts by MIME type and wildcard", async () => {
    const file = new File(["a"], "notes", { type: "text/plain" });
    await expect(readDroppedFile({ files: [file] }, ["text/*"])).resolves.toMatchObject({ name: "notes" });
  });

  it("rejects the wrong type with a human message", async () => {
    const error = await readDroppedFile({ files: [fileOf("photo.png")] }, [".docx"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LocalFileError);
    expect((error as LocalFileError).code).toBe("wrong-type");
    expect((error as LocalFileError).message).toBe("photo.png can't be opened here. Choose a .docx file.");
  });

  it("rejects files above 10 MiB", async () => {
    const big = new File([new Uint8Array(MAX_LOCAL_FILE_BYTES + 1)], "huge.xlsx");
    const error = await readDroppedFile({ files: [big] }, [".xlsx"]).catch((e: unknown) => e);
    expect((error as LocalFileError).code).toBe("too-large");
    expect((error as LocalFileError).message).toBe("huge.xlsx is larger than 10 MB. Choose a smaller file.");
  });

  it("rejects an empty drop and a drop of several files", async () => {
    await expect(readDroppedFile({ files: [] }, [".csv"])).rejects.toMatchObject({ code: "no-file" });
    await expect(readDroppedFile(null, [".csv"])).rejects.toMatchObject({ code: "no-file" });
    await expect(readDroppedFile({ files: [fileOf("a.csv"), fileOf("b.csv")] }, [".csv"])).rejects.toMatchObject({ code: "multiple" });
  });
});

describe("downloadBytes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("downloads through a temporary Blob URL and revokes it afterwards", () => {
    const create = vi.fn((_blob: Blob) => "blob:matrix/1");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    let anchor: HTMLAnchorElement | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      anchor = this;
      expect(this.isConnected).toBe(true);
    });

    downloadBytes("Budget.xlsx", new Uint8Array([1, 2, 3]), XLSX_MIME);

    expect(create).toHaveBeenCalledTimes(1);
    const blob = create.mock.calls[0][0];
    expect(blob.type).toBe(XLSX_MIME);
    expect(blob.size).toBe(3);
    expect(anchor!.download).toBe("Budget.xlsx");
    expect(anchor!.getAttribute("href")).toBe("blob:matrix/1");
    expect(anchor!.isConnected).toBe(false);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revoke).toHaveBeenCalledWith("blob:matrix/1");
  });

  it("strips folders and control characters from the file name", () => {
    Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined });
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    downloadBytes("../secret/\u0007notes.csv", new Uint8Array(), CSV_MIME);
    downloadBytes("  ", new Uint8Array(), CSV_MIME);
    expect(names).toEqual(["notes.csv", "download"]);
  });
});
