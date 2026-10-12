import { fetchMatrixCreditBalance, formatMicrousd } from "@/lib/requests/matrix-credit";

const gatewayUrl = "https://app.matrix-os.com/vm/alice";
const token = "clerk-token";
const asOf = "2026-10-08T09:00:00.000Z";
const now = Date.parse(asOf) + 30_000;

function managedCredit(overrides: Record<string, unknown> = {}) {
  return {
    kind: "managed_credit",
    authority: "matrix_ledger",
    state: "current",
    scope: "owner_entitlement",
    currency: "USD",
    usedMicrousd: 1_600_000,
    remainingMicrousd: 18_400_000,
    limitMicrousd: 50_000_000,
    periodStartedAt: "2026-10-01T00:00:00.000Z",
    resetsAt: "2026-11-01T00:00:00.000Z",
    asOf,
    credit: {
      promotionalBalanceMicrousd: 5_000_000,
      addonBalanceMicrousd: 15_000_000,
      creditBalanceMicrousd: 20_000_000,
      reservedMicrousd: 1_600_000,
      remainingBalanceMicrousd: 18_400_000,
    },
    budget: {
      monthlyBudgetMicrousd: 50_000_000,
      settledThisMonthMicrousd: 1_600_000,
      reservedThisMonthMicrousd: 0,
      remainingBudgetMicrousd: 48_400_000,
    },
    chatAvailability: {
      contractVersion: 1,
      asOf,
      eligibleBalanceMicrousd: 20_000_000,
      availableBalanceMicrousd: 18_400_000,
    },
    ...overrides,
  };
}

function gatewaySource(usage: unknown, id = "matrix_ai") {
  return {
    id,
    kind: "matrix_gateway",
    fundingKind: "matrix_included",
    providerId: "matrix",
    accountId: null,
    displayName: "Matrix AI",
    readiness: { state: "ready" },
    eligibleModelIds: [],
    usage,
  };
}

const ownAccount = {
  id: "owner_openai_profile",
  kind: "provider_account",
  fundingKind: "owner_subscription",
  providerId: "openai-codex",
  accountId: "acct_1",
  displayName: "Codex account",
  usage: { kind: "subscription_allowance", usedBasisPoints: 1200, asOf },
};

function snapshot(accessSources: unknown[]) {
  // The rest of the settings snapshot is large and not this request's business.
  return { contractVersion: 1, revision: 4, refreshedAt: asOf, harnesses: [{ id: "h1" }], accessSources };
}

function respond(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe("fetchMatrixCreditBalance", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("asks provider settings for the chat funding view and returns what Chat can spend", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(
      respond(snapshot([ownAccount, gatewaySource(managedCredit())])),
    );

    await expect(fetchMatrixCreditBalance(token, gatewayUrl, now)).resolves.toBe(18_400_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/vm/alice/api/ai/provider-settings?includeFundingState=true&includeChatFunding=true",
      expect.objectContaining({
        headers: { Authorization: "Bearer clerk-token" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchMock.mock.calls[0]![1]!.method).toBeUndefined();
  });

  it("caps the balance at what is left of the monthly budget", async () => {
    const usage = managedCredit({
      budget: {
        monthlyBudgetMicrousd: 10_000_000,
        settledThisMonthMicrousd: 7_000_000,
        reservedThisMonthMicrousd: 0,
        remainingBudgetMicrousd: 3_000_000,
      },
    });
    jest.spyOn(global, "fetch").mockResolvedValue(respond(snapshot([gatewaySource(usage)])));

    await expect(fetchMatrixCreditBalance(token, gatewayUrl, now)).resolves.toBe(3_000_000);
  });

  it("reports a zero balance as zero, not as missing", async () => {
    const usage = managedCredit({
      chatAvailability: { contractVersion: 1, asOf, eligibleBalanceMicrousd: 0, availableBalanceMicrousd: 0 },
    });
    jest.spyOn(global, "fetch").mockResolvedValue(respond(snapshot([gatewaySource(usage)])));

    await expect(fetchMatrixCreditBalance(token, gatewayUrl, now)).resolves.toBe(0);
  });

  it.each([
    ["there is no Matrix AI source", [ownAccount]],
    ["the ledger is unavailable", [gatewaySource({ kind: "unavailable", reason: "ledger_not_available", asOf: null })]],
    ["the chat funding view is absent", [gatewaySource(managedCredit({ chatAvailability: undefined }))]],
    ["the reading is marked stale", [gatewaySource(managedCredit({ state: "stale" }))]],
    ["the chat view is from another reading", [gatewaySource(managedCredit({
      chatAvailability: {
        contractVersion: 1,
        asOf: "2026-10-08T08:00:00.000Z",
        eligibleBalanceMicrousd: 20_000_000,
        availableBalanceMicrousd: 18_400_000,
      },
    }))]],
    ["an amount is not a whole non-negative number", [gatewaySource(managedCredit({
      chatAvailability: { contractVersion: 1, asOf, eligibleBalanceMicrousd: 20_000_000, availableBalanceMicrousd: -5 },
    }))]],
  ])("returns null when %s", async (_label, accessSources) => {
    jest.spyOn(global, "fetch").mockResolvedValue(respond(snapshot(accessSources)));

    await expect(fetchMatrixCreditBalance(token, gatewayUrl, now)).resolves.toBeNull();
  });

  it("returns null for a reading older than five minutes", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(respond(snapshot([gatewaySource(managedCredit())])));

    await expect(fetchMatrixCreditBalance(token, gatewayUrl, Date.parse(asOf) + 5 * 60_000 + 1)).resolves.toBeNull();
  });

  it("allows for a phone clock slightly behind the server, but not a reading from the future", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(respond(snapshot([gatewaySource(managedCredit())])));

    await expect(fetchMatrixCreditBalance(token, gatewayUrl, Date.parse(asOf) - 20_000)).resolves.toBe(18_400_000);
    await expect(fetchMatrixCreditBalance(token, gatewayUrl, Date.parse(asOf) - 10 * 60_000)).resolves.toBeNull();
  });

  it("uses the first Matrix AI source that reports a balance", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(respond(snapshot([
      gatewaySource({ kind: "unavailable", reason: "offline", asOf: null }, "matrix_ai_addon"),
      gatewaySource(managedCredit()),
    ])));

    await expect(fetchMatrixCreditBalance(token, gatewayUrl, now)).resolves.toBe(18_400_000);
  });

  it.each([
    ["HTTP 401", respond({ error: { code: "unauthorized", message: "Authentication is required." } }, 401)],
    ["HTTP 503", respond({ error: { code: "provider_settings_unavailable" } }, 503)],
    ["a payload without access sources", respond({ contractVersion: 1 })],
  ])("reports %s with the generic message only", async (_label, response) => {
    jest.spyOn(global, "fetch").mockResolvedValue(response);

    await expect(fetchMatrixCreditBalance(token, gatewayUrl, now)).rejects.toThrow("Credit balance unavailable. Try again.");
  });

  it("reports a network failure with the generic message only", async () => {
    jest.spyOn(global, "fetch").mockRejectedValue(new TypeError("Network request failed"));

    await expect(fetchMatrixCreditBalance(token, gatewayUrl, now)).rejects.toThrow("Credit balance unavailable. Try again.");
  });
});

describe("formatMicrousd", () => {
  it.each([
    [18_400_000, "$18.40"],
    [0, "$0.00"],
    [1_000_000, "$1.00"],
    [50_000, "$0.05"],
    [10_000, "$0.01"],
    [999_999, "$1.00"],
    [18_395_000, "$18.40"],
    [18_394_999, "$18.39"],
    [1_234_567_890_000, "$1,234,567.89"],
    [1_000_000_000, "$1,000.00"],
  ])("formats %d micro-USD as %s", (microusd, expected) => {
    expect(formatMicrousd(microusd)).toBe(expected);
  });

  it("shows an amount below one cent exactly instead of rounding it away", () => {
    expect(formatMicrousd(4_200)).toBe("$0.0042");
    expect(formatMicrousd(1)).toBe("$0.000001");
    expect(formatMicrousd(9_999)).toBe("$0.009999");
    expect(formatMicrousd(5_000)).toBe("$0.005");
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 0.4])("formats the unusable amount %d as zero", (microusd) => {
    expect(formatMicrousd(microusd)).toBe("$0.00");
  });
});
