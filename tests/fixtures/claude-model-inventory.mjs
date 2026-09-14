import { createInterface } from "node:readline";

// External CLI boundary fixture. No real Claude process or credentials used.
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "user") process.exit(2);
  if (message.type !== "control_request" || message.request.subtype !== "initialize") return;
  if (process.env.MATRIX_TEST_INVENTORY_OVERSIZE) {
    const output = process.env.MATRIX_TEST_INVENTORY_OVERSIZE === "stderr" ? process.stderr : process.stdout;
    output.write(" ".repeat(1_048_577) + "\n");
    // Keep initialization pending: ordering across stderr/stdout pipes is not
    // guaranteed, so a control response must not race the stderr observation.
    if (output === process.stderr) return;
  }
  process.stdout.write(JSON.stringify({ type: "control_response", response: {
    subtype: "success", request_id: message.request_id, response: {
      commands: [], agents: [], account: {}, output_style: "default", available_output_styles: [],
      models: [{ value: process.env.ANTHROPIC_API_KEY ? "unexpected-ambient-credential" : "claude-fable-5",
        displayName: "Fable", description: "" }],
    },
  } }) + "\n");
});
input.on("close", () => process.exit(0));
