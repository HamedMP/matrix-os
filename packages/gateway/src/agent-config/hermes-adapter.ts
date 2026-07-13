import {
  AgentMessagingSelectionSchema,
  AgentProviderCatalogSchema,
  AgentRuntimeDescriptorSchema,
  type AgentMessagingSelection,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import { AgentConfigError } from "./errors.js";
import type {
  MessagingRuntimeAdapter,
  RuntimeConfigureInput,
} from "./runtime-controller.js";
import type { AgentRuntimeSource } from "./service.js";

type HermesJsonRequester = (
  path: string,
  init: Omit<RequestInit, "signal" | "redirect">,
  signal: AbortSignal,
) => Promise<unknown>;

const HermesMutationResponseSchema = z.record(z.string(), z.unknown());

export function createHermesRuntimeAdapter(options: {
  source: AgentRuntimeSource;
  requestJson: HermesJsonRequester;
  activate?: (signal: AbortSignal) => Promise<void>;
  deactivate?: (signal: AbortSignal) => Promise<void>;
}): MessagingRuntimeAdapter {
  async function snapshot(signal: AbortSignal) {
    return options.source(signal);
  }

  async function configure(
    input: RuntimeConfigureInput,
    signal: AbortSignal,
  ): Promise<AgentMessagingSelection> {
    const current = await snapshot(signal);
    const providers = AgentProviderCatalogSchema.parse(current.providers);
    const provider = providers.find((entry) =>
      entry.runtime === "hermes"
      && entry.id === input.provider
      && entry.scopes.includes("messaging")
    );
    if (!provider?.models.some((model) =>
      model.id === input.model && model.available
    )) {
      throw new AgentConfigError("not_configured");
    }
    if (input.baseUrl !== undefined
      && !provider.supportedAuthKinds.includes("base_url")) {
      throw new AgentConfigError("not_configured");
    }
    const body = {
      scope: "main",
      provider: input.provider,
      model: input.model,
      ...(input.baseUrl === undefined ? {} : { base_url: input.baseUrl }),
    };
    const response = await options.requestJson("/api/model/set", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, signal);
    const parsed = HermesMutationResponseSchema.safeParse(response);
    if (!parsed.success) throw new AgentConfigError("invalid_response", parsed.error);
    options.source.invalidate?.();
    const updated = await snapshot(signal);
    const selection = AgentMessagingSelectionSchema.parse(updated.messaging);
    if (!selection.configured
      || selection.provider !== input.provider
      || selection.model !== input.model) {
      throw new AgentConfigError("invalid_response");
    }
    return selection;
  }

  return {
    id: "hermes",
    async probe(signal) {
      const current = await snapshot(signal);
      const descriptor = current.runtime.options.find((entry) => entry.id === "hermes");
      if (!descriptor) throw new AgentConfigError("invalid_response");
      return AgentRuntimeDescriptorSchema.parse(descriptor);
    },
    async catalog(signal) {
      return AgentProviderCatalogSchema.parse((await snapshot(signal)).providers);
    },
    async selection(signal) {
      return AgentMessagingSelectionSchema.parse((await snapshot(signal)).messaging);
    },
    configure,
    async prepare(signal) {
      const descriptor = await this.probe(signal);
      if (descriptor.installState !== "installed") {
        throw new AgentConfigError("runtime_unavailable");
      }
    },
    activate: options.activate ?? (async () => {}),
    deactivate: options.deactivate ?? (async () => {}),
    async dashboard() {
      return null;
    },
    async close() {},
  };
}
