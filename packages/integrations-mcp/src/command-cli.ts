#!/usr/bin/env node
import { runIntegrationsCommand } from "./command.js";

try {
  const result = await runIntegrationsCommand(process.argv.slice(2));
  process.stdout.write(`${result}\n`);
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : "";
  const safe = message.startsWith("Usage:") || message.startsWith("An exact account label")
    || message.startsWith("The CLI can only call verified read-only actions")
    || message.startsWith("Integration call failed;");
  console.error(safe ? message : "Invalid integration command.");
  process.exitCode = 64;
}
