import { MATRIX_BOT_SELECTION, type CanonicalProviderCatalog } from "@matrix-os/contracts";

import {
  agentRunsOn,
  approvalTitle,
  connectionStatusLabel,
  serviceLabel,
} from "../components/agents/agent-copy";
import { createCanonicalProviderCatalogFixture } from "../../../tests/contracts/fixtures/canonical-chat";

const recipeRef = { recipeId: "account-research", version: "v2" };
const managed = { instanceId: "matrix_pi_default", model: "claude-sonnet-5" };

function catalogWith(instance: Record<string, unknown>): CanonicalProviderCatalog {
  const catalog = createCanonicalProviderCatalogFixture();
  const base = catalog.instances[0]!;
  return {
    ...catalog,
    instances: [{
      ...base,
      id: managed.instanceId,
      driverKind: "matrix_pi",
      displayName: "Pi",
      connectionLabel: "Matrix AI",
      models: [{ ...base.models[0]!, id: managed.model, displayName: "Claude Sonnet 5" }],
      ...instance,
    }],
  } as CanonicalProviderCatalog;
}

describe("serviceLabel", () => {
  it("turns the server's slug into a name", () => {
    expect(serviceLabel("gmail")).toBe("Gmail");
    expect(serviceLabel("google_calendar")).toBe("Google Calendar");
    expect(serviceLabel("web_search")).toBe("Web Search");
  });
});

describe("approvalTitle", () => {
  it("names the service and the account when the approval is for an account", () => {
    expect(approvalTitle({
      tool: "integration.call",
      account: { service: "slack", label: "#northwind-deal" },
      audience: "direct",
    })).toBe("Slack · #northwind-deal");
  });

  it("names the tool alone when there is no account and the agent acts in its own chat", () => {
    expect(approvalTitle({ tool: "integration.call", audience: "direct" })).toBe("Integration call");
    expect(approvalTitle({ tool: "send_weekly-report", audience: "direct" })).toBe("Send weekly report");
  });

  it("names a shared chat as the target when that is where the agent acts", () => {
    expect(approvalTitle({ tool: "post_message", audience: "group:chat_team" })).toBe("Post message · Shared chat");
  });
});

describe("connectionStatusLabel", () => {
  it("words each state the server reports", () => {
    expect(connectionStatusLabel("granted")).toBe("Connected");
    expect(connectionStatusLabel("not_connected")).toBe("Not connected");
    expect(connectionStatusLabel("connected_not_granted")).toBe("Connected, not granted");
  });
});

describe("agentRunsOn", () => {
  it("names the engine, the model and where it is paid through", () => {
    expect(agentRunsOn({ recipeRef, selection: managed }, catalogWith({})))
      .toBe("Runs on Pi · Claude Sonnet 5 via Matrix AI");
  });

  it("names an agent of the person's own by its saved engine and model", () => {
    const catalog = catalogWith({ id: "claude_default", driverKind: "claude", displayName: "Claude Code", connectionLabel: "Work" });
    expect(agentRunsOn({ selection: { instanceId: "claude_default", model: managed.model } }, catalog))
      .toBe("Runs on Claude Code · Claude Sonnet 5 via Work");
  });

  it("leaves out the source when the computer names none, or names the engine again", () => {
    expect(agentRunsOn({ recipeRef, selection: managed }, catalogWith({ connectionLabel: undefined })))
      .toBe("Runs on Pi · Claude Sonnet 5");
    expect(agentRunsOn({ recipeRef, selection: managed }, catalogWith({ connectionLabel: "Pi" })))
      .toBe("Runs on Pi · Claude Sonnet 5");
  });

  it("leaves out a model the computer does not list, rather than show its id", () => {
    expect(agentRunsOn({ recipeRef, selection: { ...managed, model: "retired-model" } }, catalogWith({})))
      .toBe("Runs on Pi via Matrix AI");
  });

  it("says a template agent left to the computer runs on Automatic", () => {
    expect(agentRunsOn({ recipeRef, selection: MATRIX_BOT_SELECTION }, catalogWith({}))).toBe("Runs on Automatic");
    expect(agentRunsOn({ recipeRef, selection: MATRIX_BOT_SELECTION }, null)).toBe("Runs on Automatic");
  });

  it("says nothing when the engine is not one the computer lists", () => {
    expect(agentRunsOn({ recipeRef, selection: managed }, null)).toBeNull();
    expect(agentRunsOn({ selection: { instanceId: "gone", model: "x" } }, catalogWith({}))).toBeNull();
    // The automatic choice belongs to template agents only.
    expect(agentRunsOn({ selection: MATRIX_BOT_SELECTION }, catalogWith({}))).toBeNull();
  });
});
