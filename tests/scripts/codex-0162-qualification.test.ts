import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import execContract from "../../packages/gateway/src/coding-agents/codex-exec-contract.json" with { type: "json" };
import appServerContract from "../../packages/gateway/src/coding-agents/codex-app-server-contract.json" with { type: "json" };
import { codexTerminalFailureReason } from "../../packages/gateway/src/coding-agents/codex-terminal-failure.mjs";
import { codexProtocolMethodDigest, verifyCodexProviderContracts } from "../../scripts/lib/codex-provider-contract-check.mjs";

const bytes = (version: string) => gunzipSync(readFileSync(new URL(`../fixtures/codex-${version}/app-server-schema-${version}.json.gz`, import.meta.url)));
const reviewedDigests = {
  "item/started": "cf1ee0c03c5e17473745ae11c8328710721a8cf7074417b7a49e3e358046e2a3",
  "item/completed": "68920d904d688fc3e97522fc692ee17be5b7d9eb9435975644972ef43400d4c0",
  "turn/completed": "b2500c9932e97982d2267730d43f01ab9b93423b4b662fc6040ea776766cf728",
};

describe("published Codex 0.162.0 qualification", () => {
  it("pins published bytes and reviewed consumed payloads on both targets", () => {
    const execSchemaBytes = readFileSync(new URL("../fixtures/codex-0158/exec-events.rs", import.meta.url));
    const appServerSchemaBytes = bytes("0162");
    const schema = JSON.parse(appServerSchemaBytes.toString());
    const previous = JSON.parse(bytes("0161").toString());
    expect(createHash("sha256").update(appServerSchemaBytes).digest("hex")).toBe("e4e7f0c7d3fd77c48cd8619cad2bf2b315d860ab006ad5a7ebe44f6e32e666c1");
    for (const method of [...appServerContract.requiredServerMethods, ...appServerContract.requiredServerNotifications]) {
      const definition = appServerContract.requiredServerMethods.includes(method) ? "ServerRequest" : "ServerNotification";
      expect(codexProtocolMethodDigest(schema, definition, method)).toBe(
        reviewedDigests[method as keyof typeof reviewedDigests] ?? codexProtocolMethodDigest(previous, definition, method),
      );
    }
    for (const runtimeTarget of ["darwin-arm64", "linux-x64"]) {
      expect(() => verifyCodexProviderContracts({ version: "0.162.0", execContract,
        appServerContract, execSchemaBytes, appServerSchemaBytes, runtimeTarget })).not.toThrow();
    }
  });

  it("bounds the reviewed item/turn changes to optional metadata and the partial-answer phase (including opaque error targets)", () => {
    const current = JSON.parse(bytes("0162").toString()).definitions.v2;
    const previous = JSON.parse(bytes("0161").toString()).definitions.v2;
    const items = structuredClone(current.ThreadItem);
    const activity = items.oneOf.find((variant: { properties: { type: { enum: string[] } } }) => variant.properties.type.enum[0] === "subAgentActivity");
    expect(activity.properties.model.type).toEqual(["string", "null"]);
    expect(activity.properties.reasoningEffort.anyOf).toEqual([{ $ref: "#/definitions/v2/ReasoningEffort" }, { type: "null" }]);
    delete activity.properties.model;
    delete activity.properties.reasoningEffort;
    expect(items).toEqual(previous.ThreadItem);
    const misalignment = structuredClone(current.MisalignmentErrorDetails);
    expect(misalignment.properties.reviewTarget.type).toEqual(["string", "null"]);
    delete misalignment.properties.reviewTarget;
    expect(misalignment).toEqual(previous.MisalignmentErrorDetails);
    expect(codexTerminalFailureReason({ codexErrorInfo: "misalignment",
      misalignmentErrorDetails: { reviewTarget: "opaque-private-target", steer: null },
      message: "Not logged in" })).toBeUndefined();
    const turn = structuredClone(current.Turn);
    expect(turn.properties.rootTurnId.type).toEqual(["string", "null"]);
    delete turn.properties.rootTurnId;
    expect(turn).toEqual(previous.Turn);
    expect(current.MessagePhase.oneOf.map((variant: { enum: string[] }) => variant.enum[0])).toEqual(["commentary", "partial_answer", "final_answer"]);
    expect(current.MessagePhase.oneOf[0]).toEqual(previous.MessagePhase.oneOf[0]);
    expect(current.MessagePhase.oneOf[2].enum).toEqual(previous.MessagePhase.oneOf[1].enum);
  });
});
