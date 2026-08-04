// @vitest-environment jsdom

import React from "react";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HermesConfigurationDialog } from "../../shell/src/components/settings/sections/HermesConfigurationDialog.js";

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const configuration = {
  config: {
    model: "anthropic/claude-sonnet-4.6",
    agent: { max_turns: 90 },
    memory: { memory_enabled: true },
    approvals: { mode: "ask" },
  },
  defaults: {
    model: "anthropic/claude-sonnet-4.6",
    agent: { max_turns: 60 },
    memory: { memory_enabled: true },
    approvals: { mode: "ask" },
  },
  fields: {
    model: { type: "string", description: "Default model", category: "general" },
    "agent.max_turns": { type: "number", description: "Maximum turns", category: "agent" },
    "memory.memory_enabled": { type: "boolean", description: "Use long-term memory", category: "memory" },
    "approvals.mode": {
      type: "select",
      description: "Command approval mode",
      category: "security",
      options: ["ask", "deny"],
    },
  },
  categoryOrder: ["general", "agent", "memory", "security"],
};

const environment = {
  OPENROUTER_API_KEY: {
    is_set: true,
    redacted_value: "sk-or-••••••••abcd",
    description: "OpenRouter API key",
    url: "https://openrouter.ai/keys",
    category: "provider",
    is_password: true,
    tools: [],
    advanced: false,
    channel_managed: false,
    provider: "openrouter",
    provider_label: "OpenRouter",
  },
  DISCORD_BOT_TOKEN: {
    is_set: true,
    redacted_value: "••••discord",
    description: "Discord bot token",
    category: "messaging",
    is_password: true,
    tools: [],
    advanced: false,
    channel_managed: true,
    provider: "",
    provider_label: "",
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Hermes configuration dialog", () => {
  it("renders version-aware categories and saves only changed typed fields", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/hermes/configuration") && init?.method === "PUT") {
        return response({ ok: true, config: { ...configuration.config, agent: { max_turns: 120 } } });
      }
      if (url.endsWith("/api/hermes/configuration")) return response(configuration);
      if (url.endsWith("/api/hermes/env")) return response(environment);
      return response({}, 404);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<HermesConfigurationDialog open onOpenChange={vi.fn()} version="0.17.0" />);

    expect(await screen.findByRole("heading", { name: "Configure Hermes" })).toBeVisible();
    expect(screen.getByRole("dialog")).toHaveStyle({ zIndex: "11000" });
    expect(screen.getByRole("dialog")).toHaveClass("sm:max-w-5xl");
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toHaveStyle({ zIndex: "11000" });
    expect(screen.getByText("Version 0.17.0")).toBeVisible();
    expect(screen.getByText("4 settings discovered from this Hermes installation")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Agent, 1 setting" }));
    const turns = screen.getByRole("spinbutton", { name: "Maximum turns" });
    expect(turns).toHaveValue(90);
    fireEvent.change(turns, { target: { value: "120" } });
    expect(screen.getByText("1 unsaved change")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save Hermes settings" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/api/hermes/configuration"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ changes: [{ path: "agent.max_turns", value: 120 }] }),
      }),
    ));
    expect(await screen.findByText("Hermes settings saved")).toBeVisible();
  });

  it("preserves edits made while an older settings save is pending", async () => {
    let resolveSave: ((value: Response) => void) | undefined;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/hermes/configuration") && init?.method === "PUT") {
        return new Promise<Response>((resolve) => {
          resolveSave = resolve;
        });
      }
      if (url.endsWith("/api/hermes/configuration")) return response(configuration);
      if (url.endsWith("/api/hermes/env")) return response(environment);
      return response({}, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    render(<HermesConfigurationDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Agent, 1 setting" }));
    const turns = screen.getByRole("spinbutton", { name: "Maximum turns" });
    fireEvent.change(turns, { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Hermes settings" }));
    await waitFor(() => expect(resolveSave).toBeDefined());

    fireEvent.change(turns, { target: { value: "150" } });
    resolveSave?.(response({ ok: true }));

    expect(await screen.findByText(/Hermes settings saved.*1 newer unsaved change/)).toBeVisible();
    expect(turns).toHaveValue(150);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(turns).toHaveValue(120);
  });

  it("keeps a revert made during a pending save as a saveable newer change", async () => {
    let resolveFirstSave: ((value: Response) => void) | undefined;
    let saveCount = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/hermes/configuration") && init?.method === "PUT") {
        saveCount += 1;
        if (saveCount === 1) {
          return new Promise<Response>((resolve) => {
            resolveFirstSave = resolve;
          });
        }
        return response({ ok: true });
      }
      if (url.endsWith("/api/hermes/configuration")) return response(configuration);
      if (url.endsWith("/api/hermes/env")) return response(environment);
      return response({}, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    render(<HermesConfigurationDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Agent, 1 setting" }));
    const turns = screen.getByRole("spinbutton", { name: "Maximum turns" });
    fireEvent.change(turns, { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Hermes settings" }));
    await waitFor(() => expect(resolveFirstSave).toBeDefined());

    fireEvent.change(turns, { target: { value: "90" } });
    resolveFirstSave?.(response({ ok: true }));

    expect(await screen.findByText(/Hermes settings saved.*1 newer unsaved change/)).toBeVisible();
    expect(turns).toHaveValue(90);
    expect(screen.getByRole("button", { name: "Save Hermes settings" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Save Hermes settings" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/api/hermes/configuration"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ changes: [{ path: "agent.max_turns", value: 90 }] }),
      }),
    ));
  });

  it("keeps the submitted value saveable when a pending save fails", async () => {
    let resolveSave: ((value: Response) => void) | undefined;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/hermes/configuration") && init?.method === "PUT") {
        return new Promise<Response>((resolve) => {
          resolveSave = resolve;
        });
      }
      if (url.endsWith("/api/hermes/configuration")) return response(configuration);
      if (url.endsWith("/api/hermes/env")) return response(environment);
      return response({}, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    render(<HermesConfigurationDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Agent, 1 setting" }));
    const turns = screen.getByRole("spinbutton", { name: "Maximum turns" });
    fireEvent.change(turns, { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Hermes settings" }));
    await waitFor(() => expect(resolveSave).toBeDefined());

    fireEvent.change(turns, { target: { value: "120" } });
    resolveSave?.(response({}, 500));

    expect(await screen.findByText("Hermes configuration could not be saved.")).toBeVisible();
    expect(turns).toHaveValue(120);
    expect(screen.getByRole("button", { name: "Save Hermes settings" })).toBeEnabled();
  });

  it("merges a pending save into configuration freshly loaded after reopening", async () => {
    let resolveSave: ((value: Response) => void) | undefined;
    let configurationReads = 0;
    const freshConfiguration = {
      ...configuration,
      config: { ...configuration.config, model: "openai/gpt-5", fresh: { enabled: true } },
      defaults: { ...configuration.defaults, fresh: { enabled: false } },
      fields: {
        ...configuration.fields,
        "fresh.enabled": { type: "boolean", description: "Fresh runtime setting", category: "fresh" },
      },
      categoryOrder: [...configuration.categoryOrder, "fresh"],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/hermes/configuration") && init?.method === "PUT") {
        return new Promise<Response>((resolve) => {
          resolveSave = resolve;
        });
      }
      if (url.endsWith("/api/hermes/configuration")) {
        configurationReads += 1;
        return response(configurationReads === 1 ? configuration : freshConfiguration);
      }
      if (url.endsWith("/api/hermes/env")) return response(environment);
      return response({}, 404);
    }));

    function Harness() {
      const [open, setOpen] = React.useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open Hermes configuration</button>
          <HermesConfigurationDialog open={open} onOpenChange={setOpen} />
        </>
      );
    }
    render(<Harness />);

    fireEvent.click(await screen.findByRole("button", { name: "Agent, 1 setting" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Maximum turns" }), { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Hermes settings" }));
    await waitFor(() => expect(resolveSave).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Open Hermes configuration" }));
    expect(await screen.findByRole("button", { name: "Fresh, 1 setting" })).toBeVisible();

    resolveSave?.(response({ ok: true }));

    expect(await screen.findByRole("button", { name: "Fresh, 1 setting" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "General, 1 setting" }));
    expect(screen.getByRole("textbox", { name: "Default model" })).toHaveValue("openai/gpt-5");
    fireEvent.click(screen.getByRole("button", { name: "Agent, 1 setting" }));
    expect(screen.getByRole("spinbutton", { name: "Maximum turns" })).toHaveValue(120);
  });

  it("searches all exact-version fields and restores an individual default", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => (
      String(input).endsWith("/api/hermes/env") ? response(environment) : response(configuration)
    )));
    render(<HermesConfigurationDialog open onOpenChange={vi.fn()} />);

    const search = await screen.findByRole("searchbox", { name: "Search Hermes settings" });
    fireEvent.change(search, { target: { value: "maximum turns" } });
    expect(screen.getByRole("spinbutton", { name: "Maximum turns" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Restore default for Maximum turns" }));
    expect(screen.getByRole("spinbutton", { name: "Maximum turns" })).toHaveValue(60);
  });

  it("manages write-only credentials without duplicating channel-owned secrets", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/hermes/configuration")) return response(configuration);
      if (url.endsWith("/api/hermes/env") && init?.method) return response({ ok: true });
      if (url.endsWith("/api/hermes/env")) return response(environment);
      return response({}, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    render(<HermesConfigurationDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole("tab", { name: "Credentials" }));
    expect(screen.getByText("OpenRouter")).toBeVisible();
    expect(screen.queryByText("Discord bot token")).not.toBeInTheDocument();
    expect(screen.getByText("sk-or-••••••••abcd")).toBeVisible();
    const input = screen.getByLabelText("New OpenRouter API key");
    expect(input).toHaveAttribute("type", "password");
    fireEvent.change(input, { target: { value: "sk-or-new-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save OpenRouter credential" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/api/hermes/env"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ key: "OPENROUTER_API_KEY", value: "sk-or-new-secret" }),
      }),
    ));
    expect(input).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "Remove OpenRouter credential" }));
    expect(screen.getByRole("button", { name: "Remove OpenRouter credential" })).toHaveTextContent("Confirm remove");
    fireEvent.click(screen.getByRole("button", { name: "Remove OpenRouter credential" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/api/hermes/env"),
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ key: "OPENROUTER_API_KEY" }),
      }),
    ));
  });

  it("blocks saving when a list setting contains invalid JSON", async () => {
    const listConfiguration = {
      ...configuration,
      config: { ...configuration.config, tools: { allowed: ["bash"] } },
      defaults: { ...configuration.defaults, tools: { allowed: [] } },
      fields: {
        ...configuration.fields,
        "tools.allowed": { type: "list", description: "Allowed tools", category: "tools" },
      },
      categoryOrder: [...configuration.categoryOrder, "tools"],
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => (
      String(input).endsWith("/api/hermes/env") ? response(environment) : response(listConfiguration)
    ));
    vi.stubGlobal("fetch", fetcher);
    render(<HermesConfigurationDialog open onOpenChange={vi.fn()} />);

    const search = await screen.findByRole("searchbox", { name: "Search Hermes settings" });
    fireEvent.change(search, { target: { value: "allowed tools" } });
    const list = screen.getByRole("textbox", { name: "Allowed tools" });
    fireEvent.change(list, { target: { value: '["bash", "python"]' } });
    fireEvent.change(list, { target: { value: '["bash"' } });

    expect(screen.getByText("Enter a valid JSON list before saving.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save Hermes settings" })).toBeDisabled();
    fireEvent.change(search, { target: { value: "maximum turns" } });
    expect(screen.getByRole("spinbutton", { name: "Maximum turns" })).toBeVisible();
    fireEvent.change(search, { target: { value: "allowed tools" } });
    expect(screen.getByRole("textbox", { name: "Allowed tools" })).toHaveValue('["bash"');
    expect(screen.getByText("Enter a valid JSON list before saving.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save Hermes settings" })).toBeDisabled();
    expect(fetcher).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/hermes/configuration"),
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("keeps an emptied number blank and blocks saving instead of converting it to zero", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => (
      String(input).endsWith("/api/hermes/env") ? response(environment) : response(configuration)
    )));
    render(<HermesConfigurationDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Agent, 1 setting" }));
    const turns = screen.getByRole("spinbutton", { name: "Maximum turns" });
    fireEvent.change(turns, { target: { value: "120" } });
    fireEvent.change(turns, { target: { value: "" } });

    expect(turns).toHaveValue(null);
    expect(screen.getByText("Enter a number before saving.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save Hermes settings" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "General, 1 setting" }));
    fireEvent.click(screen.getByRole("button", { name: "Agent, 1 setting" }));
    expect(screen.getByRole("spinbutton", { name: "Maximum turns" })).toHaveValue(null);
    expect(screen.getByText("Enter a number before saving.")).toBeVisible();
  });

  it("keeps a successful credential mutation when only its status refresh fails", async () => {
    let environmentReads = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/hermes/configuration")) return response(configuration);
      if (url.endsWith("/api/hermes/env") && init?.method === "PUT") return response({ ok: true });
      if (url.endsWith("/api/hermes/env")) {
        environmentReads += 1;
        return environmentReads === 1 ? response(environment) : response({}, 503);
      }
      return response({}, 404);
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetcher);
    render(<HermesConfigurationDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole("tab", { name: "Credentials" }));
    const input = screen.getByLabelText("New OpenRouter API key");
    fireEvent.change(input, { target: { value: "sk-or-new-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save OpenRouter credential" }));

    expect(await screen.findByText("Credential saved. Live status could not be refreshed.")).toBeVisible();
    expect(input).toHaveValue("");
    expect(screen.getByText("Connected")).toBeVisible();
    expect(screen.queryByText("sk-or-••••••••abcd")).not.toBeInTheDocument();
    expect(screen.queryByText("Credential could not be saved.")).not.toBeInTheDocument();
  });

  it("preserves unsaved invalid text when the dialog closes and reopens", async () => {
    const listConfiguration = {
      ...configuration,
      config: { ...configuration.config, tools: { allowed: ["bash"] } },
      defaults: { ...configuration.defaults, tools: { allowed: [] } },
      fields: {
        ...configuration.fields,
        "tools.allowed": { type: "list", description: "Allowed tools", category: "tools" },
      },
      categoryOrder: [...configuration.categoryOrder, "tools"],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => (
      String(input).endsWith("/api/hermes/env") ? response(environment) : response(listConfiguration)
    )));

    function Harness() {
      const [open, setOpen] = React.useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open Hermes configuration</button>
          <HermesConfigurationDialog open={open} onOpenChange={setOpen} />
        </>
      );
    }
    render(<Harness />);

    const search = await screen.findByRole("searchbox", { name: "Search Hermes settings" });
    fireEvent.change(search, { target: { value: "allowed tools" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Allowed tools" }), { target: { value: '["bash"' } });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Open Hermes configuration" }));

    expect(await screen.findByRole("textbox", { name: "Allowed tools" })).toHaveValue('["bash"');
    expect(screen.getByText("Enter a valid JSON list before saving.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save Hermes settings" })).toBeDisabled();
  });

  it("ignores an older credential refresh that resolves after a newer mutation", async () => {
    const initialEnvironment = {
      ...environment,
      OPENAI_API_KEY: {
        ...environment.OPENROUTER_API_KEY,
        is_set: false,
        redacted_value: "",
        description: "OpenAI API key",
        provider: "openai",
        provider_label: "OpenAI",
      },
    };
    const newerEnvironment = {
      ...initialEnvironment,
      OPENROUTER_API_KEY: {
        ...initialEnvironment.OPENROUTER_API_KEY,
        is_set: true,
        redacted_value: "••••new-router",
      },
      OPENAI_API_KEY: {
        ...initialEnvironment.OPENAI_API_KEY,
        is_set: true,
        redacted_value: "••••new-openai",
      },
    };
    let environmentReads = 0;
    const pendingRefreshes: Array<(value: Response) => void> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/hermes/configuration")) return response(configuration);
      if (url.endsWith("/api/hermes/env") && init?.method === "PUT") return response({ ok: true });
      if (url.endsWith("/api/hermes/env")) {
        environmentReads += 1;
        if (environmentReads === 1) return response(initialEnvironment);
        return new Promise<Response>((resolve) => pendingRefreshes.push(resolve));
      }
      return response({}, 404);
    }));
    render(<HermesConfigurationDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole("tab", { name: "Credentials" }));
    const routerInput = screen.getByLabelText("New OpenRouter API key");
    const openaiInput = screen.getByLabelText("New OpenAI API key");
    fireEvent.change(routerInput, { target: { value: "router-new" } });
    fireEvent.change(openaiInput, { target: { value: "openai-new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save OpenRouter credential" }));
    fireEvent.click(screen.getByRole("button", { name: "Save OpenAI credential" }));
    await waitFor(() => expect(pendingRefreshes).toHaveLength(2));

    pendingRefreshes[1](response(newerEnvironment));
    expect(await screen.findByText("••••new-router")).toBeVisible();
    expect(screen.getByText("••••new-openai")).toBeVisible();
    pendingRefreshes[0](response(initialEnvironment));
    await waitFor(() => expect(screen.queryByText("sk-or-••••••••abcd")).not.toBeInTheDocument());
    expect(screen.getByText("••••new-router")).toBeVisible();
    expect(screen.getByText("••••new-openai")).toBeVisible();
  });
});
