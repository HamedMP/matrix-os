import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Loaded explicitly while --no-extensions disables owner/project discovery.
// Pi's own extension loader resolves typebox; it is not a gateway dependency.
const SOURCE = `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "ask_user", label: "Ask user",
    description: "Ask the user for clarification and wait for their answer before continuing.",
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 600 }),
      options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { minItems: 1, maxItems: 10 }))
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) return { content: [{ type: "text", text: "User input is unavailable." }], details: {} };
      const answer = params.options?.length
        ? await ctx.ui.select(params.question, params.options, { signal, timeout: 240000 })
        : await ctx.ui.input(params.question, undefined, { signal, timeout: 240000 });
      return { content: [{ type: "text", text: answer === undefined ? "The question was cancelled or expired." : answer }], details: {} };
    }
  });
}
`;

export async function createPiOwnedExtension(): Promise<{ path: string; dispose: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "matrix-pi-extension-"));
  try {
    const path = join(directory, "ask-user.ts");
    await writeFile(path, SOURCE, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return { path, dispose: () => rm(directory, { recursive: true, force: true }) };
  } catch (error: unknown) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
