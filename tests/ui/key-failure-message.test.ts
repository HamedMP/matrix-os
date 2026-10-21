import { describe, expect, it } from "vitest";
import { keyFailureMessage } from "../../packages/ui/src/agents-providers/key-format.js";

describe("API key failure wording", () => {
  it("names the provider and the fix for a refused key", () => {
    expect(keyFailureMessage("rejected", "anthropic")).toBe("Anthropic didn't accept this key. Check that you copied all of it, or create a new key in your Anthropic account.");
    expect(keyFailureMessage("rejected", "openai")).toBe("OpenAI didn't accept this key. Check that you copied all of it, or create a new key in your OpenAI account.");
    expect(keyFailureMessage("rejected", "anthropic", "short")).toBe("Anthropic didn't accept this key");
  });

  it("says how to fix a key outside any workspace", () => {
    expect(keyFailureMessage("key_workspace_required", "anthropic")).toBe("This key isn't in a workspace. In the Anthropic Console, create a key inside a workspace, then paste it here.");
    expect(keyFailureMessage("key_workspace_required", "anthropic", "short")).toBe("This key isn't in a workspace");
  });

  it("keeps an uncertain failure from blaming the key", () => {
    expect(keyFailureMessage("unavailable", "anthropic")).toBe("Could not confirm the connection. Check its status before trying again.");
    expect(keyFailureMessage("unavailable", "anthropic", "short")).toBe("Couldn't connect right now. Try again.");
  });
});
