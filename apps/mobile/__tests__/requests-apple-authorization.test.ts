jest.mock("@/lib/storage", () => ({
  HOSTED_GATEWAY_URL: "https://app.matrix-os.com",
}));

import { registerAppleAuthorizationCode } from "@/lib/requests/apple-authorization";

describe("Apple authorization requests", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("posts the one-use code to the platform with the Clerk session token", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValue({ ok: true, json: jest.fn() } as unknown as Response);

    await expect(
      registerAppleAuthorizationCode("clerk-token", "apple-auth-code"),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://app.matrix-os.com/api/account/apple-token");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: "Bearer clerk-token",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({ code: "apple-auth-code" });
    // The platform must never hang a sign-in that has already succeeded.
    expect(init.signal).toBeDefined();
  });

  it("always targets the hosted platform, which owns the account API", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValue({ ok: true } as unknown as Response);

    await registerAppleAuthorizationCode("clerk-token", "apple-auth-code");

    expect(String(fetchMock.mock.calls[0][0]).startsWith("https://app.matrix-os.com/")).toBe(true);
  });

  it("rejects with a generic message when the platform refuses the code", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({ ok: false, status: 503 } as unknown as Response);

    await expect(registerAppleAuthorizationCode("clerk-token", "apple-auth-code")).rejects.toThrow(
      "Apple authorization could not be registered.",
    );
  });

  it("does not call the platform without a session token", async () => {
    const fetchMock = jest.spyOn(global, "fetch");

    await expect(registerAppleAuthorizationCode(" ", "apple-auth-code")).rejects.toThrow(
      "Apple authorization could not be registered.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
