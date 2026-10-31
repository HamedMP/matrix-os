import { writeFile } from "node:fs/promises";
import { z } from "zod/v4";
import { RoutineCliOperationSchema } from "@matrix-os/contracts/routine-cli";
import { PI_ROUTINE_EXTENSION } from "./pi-routine-extension.js";
import { createPiExtensionFiles } from "./pi-extension-files.js";
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

export async function createPiOwnedExtension(options: { routines?: boolean } = {}): Promise<{ path: string; routinePath?: string; dispose: () => Promise<void> }> {
  const files = await createPiExtensionFiles();
  const directory = files.directory;
  try {
    const path = join(directory, "ask-user.ts");
    await writeFile(path, SOURCE, { encoding: "utf8", mode: 0o600, flag: "wx" });
    let routinePath: string | undefined;
    if (options.routines) {
      routinePath = join(directory, "routines.mjs");
      const schema = JSON.stringify(z.toJSONSchema(RoutineCliOperationSchema, { target: "draft-7" }));
      await writeFile(routinePath, PI_ROUTINE_EXTENSION.replace("__MATRIX_ROUTINE_SCHEMA__", schema), { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
    return { path, routinePath, dispose: files.dispose };
  } catch (error: unknown) {
    await files.dispose();
    throw error;
  }
}
