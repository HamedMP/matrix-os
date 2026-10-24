import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("contracts native Node runtime", () => {
  it("loads explicit owner OpenAI connection contracts in raw Node", () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      const { MATRIX_OPENAI_CONNECTION_ID, MatrixOpenAiConnectionSchema,
        MatrixOpenAiSourceStateSchema, matrixOpenAiSelectionBinding } = await import("@matrix-os/contracts");
      console.log(MATRIX_OPENAI_CONNECTION_ID, typeof MatrixOpenAiConnectionSchema.safeParse,
        MatrixOpenAiSourceStateSchema.safeParse({ version: 1, revision: 0, enabled: false, credentialGeneration: null }).success,
        matrixOpenAiSelectionBinding([
          { id: "connectionRevision", value: "1" },
          { id: "credentialGeneration", value: "11111111-1111-4111-8111-111111111111" },
          { id: "api", value: "openai-completions" },
        ])?.api);
    `], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000, env: { ...process.env, NODE_OPTIONS: "" } });
    expect(output.trim()).toBe("matrix_openai_api function true openai-completions");
  });

  it("loads managed Google route and qualified funded contracts without a TypeScript resolver", () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      const { ManagedGoogleRouteDescriptorSchema, ManagedGoogleRouteResolveRequestSchema,
        GoogleQualifiedFundedCheckRequestSchema, GOOGLE_QUALIFIED_FUNDED_PROTOCOL } = await import("@matrix-os/contracts");
      console.log(typeof ManagedGoogleRouteDescriptorSchema.safeParse,
        ManagedGoogleRouteResolveRequestSchema.safeParse({ api: "anthropic-messages", canonicalModelId: "anthropic/claude-sonnet-5" }).success,
        typeof GoogleQualifiedFundedCheckRequestSchema.safeParse, GOOGLE_QUALIFIED_FUNDED_PROTOCOL);
    `], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000, env: { ...process.env, NODE_OPTIONS: "" } });
    expect(output.trim()).toBe("function true function matrix-google-qualified-funded-v1");
  });

  it("loads personal subscription peer and inference schemas without a TypeScript resolver", () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      const { ChatGptPlanPeerSnapshotSchema, ChatGptPlanRawWireSchema, ChatGptPlanWireSchema } = await import("@matrix-os/contracts");
      console.log(typeof ChatGptPlanPeerSnapshotSchema.safeParse, typeof ChatGptPlanRawWireSchema.passthrough, typeof ChatGptPlanWireSchema.safeParse);
    `], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000, env: { ...process.env, NODE_OPTIONS: "" } });
    expect(output.trim()).toBe("function function function");
  });
  it("loads the public package entrypoint without TypeScript path remapping", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import("@matrix-os/contracts").then(({ OS_VIEW_MODES, CanonicalChatContentFrameSchema, jevHermesRoute }) => console.log(OS_VIEW_MODES.join(","), typeof CanonicalChatContentFrameSchema.safeParse, jevHermesRoute({instanceId:"hermes_default",model:"openai-codex:gpt-5.6-sol"}).provider))',
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, NODE_OPTIONS: "" },
      },
    );

    expect(output.trim()).toBe("desktop,canvas function openai-codex");
  });
  it("loads the portable transcript parser subpath without a TypeScript resolver",()=>{
    const output=execFileSync(process.execPath,["--input-type=module","-e",'import("@matrix-os/contracts/local-chat-import").then(({readLocalChatJsonl,reconstructLocalChat})=>console.log(typeof readLocalChatJsonl,typeof reconstructLocalChat))'],{cwd:process.cwd(),encoding:"utf8",timeout:10000,env:{...process.env,NODE_OPTIONS:""}});
    expect(output.trim()).toBe("function function");
  });

  it("validates exported execution recovery under native Node without a TypeScript resolver", () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      const { FundedAiExecutionRecoveryRequestSchema, FUNDED_EXECUTION_RECOVERY_MIN_AGE_MS } = await import("@matrix-os/contracts");
      const request = {
        expectedOwnerId: "owner", reservationId: "reservation", tokenId: "token", expectedRequestId: "request",
        expectedStartedAt: "2026-10-03T05:00:00.000Z", expectedExpiresAt: "2026-10-03T05:01:00.000Z",
        maximumLiabilityMicrousd: 240845, localRunId: "run", localRunState: "failed",
        localRunEndedAt: "2026-10-03T05:00:10.000Z", evidenceRef: "support:terminal", reviewer: "operator:qa",
        acceptUnknownUpstreamLiability: true,
      };
      console.log(FundedAiExecutionRecoveryRequestSchema.safeParse(request).success,
        FundedAiExecutionRecoveryRequestSchema.safeParse({ ...request, maximumLiabilityMicrousd: 500001 }).success,
        FUNDED_EXECUTION_RECOVERY_MIN_AGE_MS);
    `], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000, env: { ...process.env, NODE_OPTIONS: "" } });
    expect(output.trim()).toBe("true false 960000");
  });
  it("loads managed activation schemas through the public entrypoint without a TypeScript resolver", () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      const { FundedHostActivationIdentitySchema, FundedHostActivationRequestSchema, FundedHostActivationResponseSchema } = await import("@matrix-os/contracts");
      const identity = { handle: "test-computer", machineId: "test_machine", ownerId: "test_owner",
        runtimeSlot: "primary", runtimeTokenEpoch: 2 };
      console.log(typeof FundedHostActivationRequestSchema.safeParse, typeof FundedHostActivationResponseSchema.safeParse,
        FundedHostActivationIdentitySchema.safeParse(identity).success,
        FundedHostActivationIdentitySchema.safeParse({ ...identity, runtimeTokenEpoch: 0 }).success);
    `], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000, env: { ...process.env, NODE_OPTIONS: "" } });
    expect(output.trim()).toBe("function function true false");
  });

});
