import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("contracts native Node runtime", () => {
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
});
