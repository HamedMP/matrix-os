import { describe, expect, it, vi } from "vitest";
import {
  fetchHermesConfiguration,
  fetchHermesEnvironment,
  removeHermesCredential,
  setHermesCredential,
  updateHermesConfiguration,
} from "../../desktop/src/main/hermes/configuration-client";
import type { AuthService } from "../../desktop/src/main/auth/auth-service";

function auth(runtimeSlot = "primary", token: string | null = "desktop-token"): AuthService {
  return {
    getToken: () => token,
    getGatewayOrigin: () => "https://runtime.test",
    getStatus: () => ({
      signedIn: token !== null,
      handle: "operator",
      runtimeSlot,
      platformHost: "https://runtime.test",
    }),
  } as unknown as AuthService;
}

function configurationBody() {
  return {
    config: { general: { model: "anthropic/claude-opus-4.6" } },
    defaults: { general: { model: "" } },
    fields: {
      "general.model": {
        type: "string",
        description: "Default model",
        category: "general",
      },
    },
    categoryOrder: ["general"],
  };
}

describe("Desktop Hermes configuration client", () => {
  it("fetches configuration with bearer auth for the selected runtime", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(
      JSON.stringify(configurationBody()),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    await expect(fetchHermesConfiguration(auth("preview"), fetchFn)).resolves.toEqual(configurationBody());

    expect(fetchFn).toHaveBeenCalledWith(
      "https://runtime.test/api/hermes/configuration?runtime=preview",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: {
          Authorization: "Bearer desktop-token",
          Accept: "application/json",
        },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("fetches strict credential metadata without accepting secret values", async () => {
    const environment = {
      ANTHROPIC_API_KEY: {
        is_set: true,
        redacted_value: "sk-ant-...1234",
        description: "Anthropic API key",
        category: "Providers",
        is_password: true,
        tools: ["hermes"],
        advanced: false,
        channel_managed: false,
        provider: "anthropic",
        provider_label: "Anthropic",
      },
    };
    const fetchFn = vi.fn().mockResolvedValue(Response.json(environment));

    await expect(fetchHermesEnvironment(auth(), fetchFn)).resolves.toEqual(environment);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://runtime.test/api/hermes/env",
      expect.objectContaining({ method: "GET" }),
    );

    fetchFn.mockResolvedValueOnce(Response.json({
      ...environment,
      ANTHROPIC_API_KEY: { ...environment.ANTHROPIC_API_KEY, value: "secret" },
    }));
    await expect(fetchHermesEnvironment(auth(), fetchFn)).rejects.toThrow(
      "Hermes configuration is unavailable.",
    );
  });

  it.each([
    {
      name: "configuration changes",
      call: (fetchFn: typeof fetch) => updateHermesConfiguration(auth(), {
        changes: [{ path: "general.model", value: "openai/gpt-5" }],
      }, fetchFn),
      path: "/api/hermes/configuration",
      method: "PUT",
      body: { changes: [{ path: "general.model", value: "openai/gpt-5" }] },
    },
    {
      name: "credential values",
      call: (fetchFn: typeof fetch) => setHermesCredential(auth(), {
        key: "OPENAI_API_KEY",
        value: "write-only-secret",
      }, fetchFn),
      path: "/api/hermes/env",
      method: "PUT",
      body: { key: "OPENAI_API_KEY", value: "write-only-secret" },
    },
    {
      name: "credential removal",
      call: (fetchFn: typeof fetch) => removeHermesCredential(auth(), {
        key: "OPENAI_API_KEY",
      }, fetchFn),
      path: "/api/hermes/env",
      method: "DELETE",
      body: { key: "OPENAI_API_KEY" },
    },
  ])("validates and sends $name with a bounded authenticated write", async ({ call, path, method, body }) => {
    const fetchFn = vi.fn().mockResolvedValue(Response.json({ ok: true, ignored: "legacy" }));

    await expect(call(fetchFn)).resolves.toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledWith(
      `https://runtime.test${path}`,
      expect.objectContaining({
        method,
        redirect: "error",
        headers: {
          Authorization: "Bearer desktop-token",
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("rejects invalid writes before a network request", async () => {
    const fetchFn = vi.fn();

    await expect(setHermesCredential(auth(), {
      key: "invalid-key",
      value: "secret",
    }, fetchFn)).rejects.toThrow("Hermes configuration could not be saved.");
    await expect(updateHermesConfiguration(auth(), {
      changes: [],
    }, fetchFn)).rejects.toThrow("Hermes configuration could not be saved.");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("uses 10 second reads and 15 second writes", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const readFetch = vi.fn().mockResolvedValue(Response.json(configurationBody()));
    const writeFetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));

    await fetchHermesConfiguration(auth(), readFetch);
    await setHermesCredential(auth(), { key: "OPENAI_API_KEY", value: "secret" }, writeFetch);

    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(timeout).toHaveBeenCalledWith(15_000);
    timeout.mockRestore();
  });

  it("never exposes an upstream response body or missing auth detail", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "provider failed at /home/matrix with sk-secret" }),
      { status: 502 },
    ));

    await expect(fetchHermesConfiguration(auth(), fetchFn)).rejects.toThrow(
      "Hermes configuration is unavailable.",
    );
    await expect(setHermesCredential(auth(), {
      key: "OPENAI_API_KEY",
      value: "secret",
    }, fetchFn)).rejects.toThrow("Hermes configuration could not be saved.");
    await expect(fetchHermesConfiguration(auth("primary", null), fetchFn)).rejects.toThrow(
      "Hermes configuration is unavailable.",
    );
  });
});
