import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock, platformMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  platformMock: vi.fn(() => "win32"),
}));

vi.mock("node:child_process", () => ({ execFile: execFileMock }));
vi.mock("node:os", () => ({ platform: platformMock }));

import { openBrowser } from "../../src/auth/oauth.js";

beforeEach(() => {
  execFileMock.mockReset();
  platformMock.mockReturnValue("win32");
});

afterEach(() => vi.restoreAllMocks());

describe("verification browser opening", () => {
  const windowsUrls = [
    "https://app.matrix-os.com/auth/device?user_code=BCDF-GHJK&intent=sign-in",
    "https://example.com/auth/device?value=x|y",
    "https://example.com/auth/device?value=%PATH%",
    "https://example.com/auth/device?value=\"quoted\"&next=1",
    "https://example.com/auth/device?value=';Write-Output(1);'",
    "http://[::1]:9000/auth/device?user_code=BCDF-GHJK",
  ];

  it.each(windowsUrls)("passes a Windows URL only as data: %s", (url) => {
    openBrowser(url, "BCDF-GHJK");

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = execFileMock.mock.calls[0];
    expect(command).toBe("powershell.exe");
    expect(args).toEqual([
      "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", expect.any(String),
    ]);
    const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
    expect(script).toContain("$info.FileName = $env:MATRIXOS_DEVICE_VERIFICATION_URI");
    expect(script).toContain("$info.UseShellExecute = $true");
    expect(script).toContain("[System.Diagnostics.Process]::Start($info)");
    expect(script).not.toContain(url);
    expect(script).not.toMatch(/Invoke-Expression|Start-Process|cmd(?:\.exe)?/i);
    expect(options).toMatchObject({
      shell: false,
      windowsHide: true,
      timeout: 10_000,
      env: { MATRIXOS_DEVICE_VERIFICATION_URI: new URL(url).href },
    });
    expect(args.join(" ")).not.toContain(url);
  });

  it("uses identical Windows launcher code for every URL", () => {
    for (const url of windowsUrls) openBrowser(url);
    const scripts = execFileMock.mock.calls.map(([, args]) => args.at(-1));
    expect(new Set(scripts).size).toBe(1);
  });

  it.each([
    "javascript:alert(1)", "file:///C:/Windows/example.exe", "mailto:example@example.com",
    "https://user@example.com/", "https://user:secret@example.com/",
    "https://example.com/\n?value=1", "https://example.com/\t?value=1",
    "https://example.com/\0", "https://example.com/\u001b[31m",
    "https://example.com/\u007f", "https://example.com/\u0085",
    " https://example.com/", "not a url", "//example.com/", "https://",
    `https://example.com/${"a".repeat(4096)}`,
  ])("rejects unsafe verification URLs before invoking a process: %s", (url) => {
    expect(() => openBrowser(url)).toThrow();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it.each(["bad\ncode", "\u001b[31m", "", "A".repeat(129)])(
    "rejects unsafe manual recovery codes before invoking a process", (code) => {
      expect(() => openBrowser("https://example.com/auth/device", code)).toThrow();
      expect(execFileMock).not.toHaveBeenCalled();
    },
  );

  it.each([["darwin", "open"], ["linux", "xdg-open"]])(
    "preserves URL arguments on %s", (os, command) => {
      platformMock.mockReturnValue(os);
      const url = "http://[::1]:9000/auth/device?user_code=BCDF-GHJK&intent=sign-in";
      openBrowser(url);
      expect(execFileMock).toHaveBeenCalledWith(command, [url], expect.any(Function));
    },
  );

  it("reports Windows launcher failures only on stderr with the manual code", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
      callback(new Error("PowerShell unavailable"));
    });
    openBrowser("https://example.com/auth/device", "BCDF-GHJK");
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "Could not open browser. Visit: https://example.com/auth/device\nEnter code: BCDF-GHJK",
    );
  });
});
